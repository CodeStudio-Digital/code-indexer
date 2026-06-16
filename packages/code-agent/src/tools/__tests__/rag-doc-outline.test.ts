/**
 * Coverage for `rag_doc_outline` — structural navigation over the doc corpus.
 * The backend is faked via setGlobalDocSearch; these tests pin how the tool
 * renders a collection's source list vs a source's heading tree, plus the
 * actionable errors.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ragDocOutlineTool } from '@mcp/code-agent/tools/rag-doc-outline.js';
import {
  setGlobalDocSearch,
  type DocOutline,
  type DocSearchBackend,
} from '@mcp/code-agent/tools/rag-search-docs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const ctx = {} as ToolContext;
const emptySearch = async () => ({
  results: [],
  diag: { fts_hits: 0, vector_hits: 0, mode: 'fts' as const, embedding_available: false, vector_available: false },
});

function backendWith(
  outline: (input: { source_id?: number; collection?: string }) => Promise<DocOutline | null>,
): DocSearchBackend {
  return { search: emptySearch, outline };
}

afterEach(() => setGlobalDocSearch(null));

describe('rag_doc_outline', () => {
  it("lists a collection's sources with their source_ids", async () => {
    setGlobalDocSearch(
      backendWith(async () => ({
        kind: 'sources',
        collection: 'unity-docs',
        sources: [
          { source_id: 5, type: 'url', doc_type: 'api_reference', title: 'ScriptReference', uri: 'https://docs.unity.com', chunk_count: 1200 },
        ],
      })),
    );
    const res = await ragDocOutlineTool.handler({ collection: 'unity-docs' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('source_id 5');
    expect(res.content).toContain('api_reference');
    expect(res.content).toContain('rag_doc_outline({source_id})');
  });

  it('renders a source heading tree with chunk_ids and part counts', async () => {
    setGlobalDocSearch(
      backendWith(async () => ({
        kind: 'headings',
        collection: 'react-docs',
        source_id: 3,
        title: 'React reference',
        source_uri: 'https://react.dev',
        doc_type: 'api_reference',
        headings: [
          { heading_path: 'Hooks > useEffect', chunk_id: 10, ord: 0, sections: 2, tokens: 300, source_uri: 'https://react.dev/useEffect' },
          { heading_path: 'Hooks > useMemo', chunk_id: 12, ord: 2, sections: 1, tokens: 120, source_uri: 'https://react.dev/useMemo' },
        ],
      })),
    );
    const res = await ragDocOutlineTool.handler({ source_id: 3 }, ctx);
    expect(res.content).toContain('Hooks > useEffect — chunk_id 10');
    expect(res.content).toContain('2 parts');
    expect(res.content).toContain('rag_read_doc({chunk_id})');
  });

  it('requires a collection or a source_id', async () => {
    setGlobalDocSearch(backendWith(async () => null));
    const res = await ragDocOutlineTool.handler({}, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('collection name');
  });

  it('errors on an unknown source', async () => {
    setGlobalDocSearch(backendWith(async () => null));
    const res = await ragDocOutlineTool.handler({ source_id: 99 }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('No source with id 99');
  });

  it('errors cleanly without the outline verb', async () => {
    setGlobalDocSearch({ search: emptySearch });
    const res = await ragDocOutlineTool.handler({ collection: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('not available');
  });
});
