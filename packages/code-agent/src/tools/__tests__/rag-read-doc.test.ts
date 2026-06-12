/**
 * Coverage for `rag_read_doc` — the full-content companion to
 * rag_search_docs. Backend is faked via setGlobalDocSearch; these tests pin
 * the agent-facing contract:
 *   - full chunk content + neighbor previews (with their chunk_ids);
 *   - long neighbors are truncated with a "read the rest" pointer;
 *   - stale chunk_id, missing backend and missing readChunk verb all error
 *     with actionable messages.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ragReadDocTool } from '@mcp/code-agent/tools/rag-read-doc.js';
import {
  setGlobalDocSearch,
  type DocChunkRead,
  type DocSearchBackend,
} from '@mcp/code-agent/tools/rag-search-docs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const ctx = {} as ToolContext;

function read(partial: Partial<DocChunkRead> = {}): DocChunkRead {
  return {
    chunk: {
      chunk_id: 10,
      collection: 'react-docs',
      source_id: 1,
      source_uri: 'https://react.dev/reference/useEffect',
      heading_path: 'Hooks > useEffect',
      content: 'useEffect lets you synchronize a component with an external system.',
      token_count: 120,
      summary: null,
      concepts: ['hooks'],
    },
    prev: [],
    next: [],
    ...partial,
  };
}

function backendWith(result: DocChunkRead | null): DocSearchBackend {
  return {
    search: async () => ({ results: [], diag: { fts_hits: 0, vector_hits: 0, mode: 'fts', embedding_available: false, vector_available: false } }),
    readChunk: async () => result,
  };
}

afterEach(() => setGlobalDocSearch(null));

describe('rag_read_doc', () => {
  it('renders the full chunk with heading, source and neighbors', async () => {
    setGlobalDocSearch(
      backendWith(
        read({
          prev: [{ chunk_id: 9, ord: 1, heading_path: 'Hooks > Intro', content: 'Intro text', token_count: 10 }],
          next: [{ chunk_id: 11, ord: 3, heading_path: 'Hooks > useMemo', content: 'Memo text', token_count: 10 }],
        }),
      ),
    );
    const res = await ragReadDocTool.handler({ chunk_id: 10 }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('# Hooks > useEffect — react-docs');
    expect(res.content).toContain('Source: https://react.dev/reference/useEffect');
    expect(res.content).toContain('synchronize a component');
    expect(res.content).toContain('Previous section — chunk_id 9');
    expect(res.content).toContain('Next section — chunk_id 11');
  });

  it('truncates long neighbor previews with a follow-up pointer', async () => {
    setGlobalDocSearch(
      backendWith(
        read({
          next: [{ chunk_id: 11, ord: 3, heading_path: null, content: 'x'.repeat(5000), token_count: 900 }],
        }),
      ),
    );
    const res = await ragReadDocTool.handler({ chunk_id: 10 }, ctx);
    expect(res.content).toContain('rag_read_doc({chunk_id: 11}) for the rest');
  });

  it('errors with guidance on a stale chunk_id', async () => {
    setGlobalDocSearch(backendWith(null));
    const res = await ragReadDocTool.handler({ chunk_id: 999 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('Run rag_search_docs again');
  });

  it('errors cleanly without a backend or without the readChunk verb', async () => {
    setGlobalDocSearch(null);
    const missing = await ragReadDocTool.handler({ chunk_id: 1 }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('not configured');

    setGlobalDocSearch({ search: async () => ({ results: [], diag: { fts_hits: 0, vector_hits: 0, mode: 'fts', embedding_available: false, vector_available: false } }) });
    const noVerb = await ragReadDocTool.handler({ chunk_id: 1 }, ctx);
    expect(noVerb.isError).toBe(true);
    expect(noVerb.content).toContain('not available');
  });

  it('rejects a non-numeric chunk_id', async () => {
    const res = await ragReadDocTool.handler({ chunk_id: 'abc' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('positive number');
  });
});
