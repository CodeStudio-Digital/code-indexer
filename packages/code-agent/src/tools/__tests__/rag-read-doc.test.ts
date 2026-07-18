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
  type DocSectionRead,
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
      anchor: 'useeffect',
      api_symbol: null,
      api_signature: null,
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
          prev: [{ chunk_id: 9, ord: 1, heading_path: 'Hooks > Intro', content: 'Intro text', token_count: 10, source_uri: 'https://react.dev/reference/useEffect' }],
          next: [{ chunk_id: 11, ord: 3, heading_path: 'Hooks > useMemo', content: 'Memo text', token_count: 10, source_uri: 'https://react.dev/reference/useEffect' }],
        }),
      ),
    );
    const res = await ragReadDocTool.handler({ chunk_id: 10 }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('# Hooks > useEffect — react-docs');
    expect(res.content).toContain('Source: https://react.dev/reference/useEffect#useeffect');
    expect(res.content).toContain('synchronize a component');
    expect(res.content).toContain('Previous section — chunk_id 9');
    expect(res.content).toContain('Next section — chunk_id 11');
  });

  it('truncates long neighbor previews with a follow-up pointer', async () => {
    setGlobalDocSearch(
      backendWith(
        read({
          next: [{ chunk_id: 11, ord: 3, heading_path: null, content: 'x'.repeat(5000), token_count: 900, source_uri: null }],
        }),
      ),
    );
    const res = await ragReadDocTool.handler({ chunk_id: 10 }, ctx);
    expect(res.content).toContain('rag_read_doc({chunk_id: 11}) for the rest');
    expect(res.sourceTruncations).toEqual([{
      technique: 'rag-neighbor-preview',
      inputSize: 5_000,
      outputSize: 1_200,
      unit: 'chars',
      recoverable: true,
    }]);
  });

  it('keeps neighbor preview boundaries Unicode-safe and reports actual retained chars', async () => {
    const content = `${'a'.repeat(1_199)}🙂tail`;
    setGlobalDocSearch(backendWith(read({
      next: [{ chunk_id: 11, ord: 3, heading_path: null, content, token_count: 900, source_uri: null }],
    })));

    const res = await ragReadDocTool.handler({ chunk_id: 10 }, ctx);
    expect(res.content).toContain(`${'a'.repeat(1_199)}…`);
    expect(res.content).not.toContain('\uFFFD');
    expect(res.sourceTruncations?.[0]?.outputSize).toBe(1_199);
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

  it('flags a neighbor that came from a different page', async () => {
    setGlobalDocSearch(
      backendWith(
        read({
          next: [{ chunk_id: 11, ord: 3, heading_path: 'Other', content: 'other page text', token_count: 10, source_uri: 'https://react.dev/reference/useMemo' }],
        }),
      ),
    );
    const res = await ragReadDocTool.handler({ chunk_id: 10 }, ctx);
    expect(res.content).toContain('different page: https://react.dev/reference/useMemo');
  });

  it("mode:'section' reassembles all parts of a heading", async () => {
    const section: DocSectionRead = {
      source_id: 1,
      collection: 'react-docs',
      source_uri: 'https://react.dev/reference/useEffect',
      heading_path: 'Hooks > useEffect',
      anchor: 'useeffect',
      api_symbol: 'useEffect',
      api_signature: 'useEffect(setup, dependencies?)',
      doc_type: 'api_reference',
      chunks: [
        { chunk_id: 10, ord: 2, content: 'Part one of the section.', token_count: 50 },
        { chunk_id: 11, ord: 3, content: 'Part two of the section.', token_count: 50 },
      ],
      total_tokens: 100,
    };
    setGlobalDocSearch({
      search: async () => ({ results: [], diag: { fts_hits: 0, vector_hits: 0, mode: 'fts', embedding_available: false, vector_available: false } }),
      readSection: async () => section,
    });
    const res = await ragReadDocTool.handler({ chunk_id: 10, mode: 'section' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('[full section]');
    expect(res.content).toContain('Part one of the section.');
    expect(res.content).toContain('Part two of the section.');
    expect(res.content).toContain('api_reference');
    expect(res.content).toContain('Signature: useEffect(setup, dependencies?)');
  });

  it("mode:'section' errors cleanly when the verb is unavailable", async () => {
    setGlobalDocSearch({ search: async () => ({ results: [], diag: { fts_hits: 0, vector_hits: 0, mode: 'fts', embedding_available: false, vector_available: false } }) });
    const res = await ragReadDocTool.handler({ chunk_id: 10, mode: 'section' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('section mode is not available');
  });

  it("mode:'section' preserves more than the legacy 12-part boundary", async () => {
    const chunks = Array.from({ length: 14 }, (_, index) => ({
      chunk_id: index + 1,
      ord: index,
      content: `section-part-${index + 1}`,
      token_count: 10,
    }));
    setGlobalDocSearch({
      search: async () => ({ results: [], diag: { fts_hits: 0, vector_hits: 0, mode: 'fts', embedding_available: false, vector_available: false } }),
      readSection: async () => ({
        source_id: 1,
        collection: 'docs',
        source_uri: null,
        heading_path: 'Long section',
        anchor: null,
        api_symbol: null,
        api_signature: null,
        doc_type: null,
        chunks,
        total_tokens: 140,
      }),
    });

    const res = await ragReadDocTool.handler({ chunk_id: 1, mode: 'section' }, ctx);
    expect(res.content).toContain('14 chunk(s)');
    expect(res.content).toContain('section-part-14');
    expect(res.content).not.toContain('section capped');
  });
});
