/**
 * Rendering coverage for the bootstrap `rag_search_docs` tool (Fase 2):
 *   - calibrated relevance is shown with a confidence band;
 *   - a calibrated "no good match" is reported as a real answer instead of
 *     citing a weak hit;
 *   - uncalibrated results fall back to the (flagged) RRF score;
 *   - a missing backend errors cleanly.
 *
 * The search engine itself is mocked via setGlobalDocSearch — these tests
 * are about how the tool PRESENTS results to the agent.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ragSearchDocsTool,
  setGlobalDocSearch,
  type DocSearchBackend,
} from '@mcp/code-agent/tools/rag-search-docs.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const ctx = {} as ToolContext;

type SearchResponse = Awaited<ReturnType<DocSearchBackend['search']>>;

function backendReturning(response: SearchResponse): DocSearchBackend {
  return { search: async () => response };
}

function diag(extra: Partial<SearchResponse['diag']> = {}): SearchResponse['diag'] {
  return {
    fts_hits: 1,
    vector_hits: 1,
    mode: 'hybrid',
    embedding_available: true,
    vector_available: true,
    ...extra,
  };
}

afterEach(() => setGlobalDocSearch(null));

describe('rag_search_docs rendering', () => {
  it('renders calibrated relevance with a confidence band', async () => {
    setGlobalDocSearch(
      backendReturning({
        results: [
          {
            chunk_id: 1,
            collection: 'unity-docs',
            source_id: 1,
            source_uri: 'https://docs.unity.com/Rigidbody.AddForce',
            heading_path: 'Physics > Rigidbody',
            anchor: null,
            api_symbol: null,
            api_signature: null,
            snippet: 'AddForce applies a force to the Rigidbody.',
            score: 0.0164,
            relevance: 0.88,
            summary: null,
            concepts: ['physics'],
          },
        ],
        diag: diag(),
      }),
    );
    const res = await ragSearchDocsTool.handler({ query: 'AddForce' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('Relevance: 0.88 (high)');
    expect(res.content).not.toContain('Score:');
  });

  it('reports an honest no-good-match instead of citing weak hits', async () => {
    setGlobalDocSearch(
      backendReturning({
        results: [],
        diag: diag({ no_good_match: true, top_relevance: 0.31 }),
      }),
    );
    const res = await ragSearchDocsTool.handler({ query: 'something obscure' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('No sufficiently relevant documentation');
    expect(res.content).toContain('0.31');
  });

  it('falls back to the uncalibrated RRF score when relevance is null', async () => {
    setGlobalDocSearch(
      backendReturning({
        results: [
          {
            chunk_id: 2,
            collection: 'docs',
            source_id: 1,
            source_uri: null,
            heading_path: 'A',
            anchor: null,
            api_symbol: null,
            api_signature: null,
            snippet: 'text',
            score: 0.014,
            relevance: null,
            summary: null,
            concepts: [],
          },
        ],
        diag: diag({ vector_available: false, mode: 'fts' }),
      }),
    );
    const res = await ragSearchDocsTool.handler({ query: 'q' }, ctx);
    expect(res.content).toContain('Score: 0.0140 (uncalibrated)');
  });

  it('errors cleanly when the backend is not wired', async () => {
    setGlobalDocSearch(null);
    const res = await ragSearchDocsTool.handler({ query: 'q' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('not configured');
  });

  it('prints chunk_id per result and the rag_read_doc footer', async () => {
    setGlobalDocSearch(
      backendReturning({
        results: [
          {
            chunk_id: 42,
            collection: 'react-docs',
            source_id: 1,
            source_uri: 'https://react.dev/x',
            heading_path: 'Hooks > useEffect',
            anchor: 'useeffect',
            api_symbol: 'useEffect',
            api_signature: 'useEffect(setup, dependencies?)',
            snippet: 'snippet',
            score: 0.01,
            relevance: 0.8,
            summary: null,
            concepts: [],
          },
        ],
        diag: diag(),
      }),
    );
    const res = await ragSearchDocsTool.handler({ query: 'q' }, ctx);
    expect(res.content).toContain('chunk_id: 42');
    expect(res.content).toContain('rag_read_doc({chunk_id})');
    // Deep-link anchor + API signature surfaced for grounding.
    expect(res.content).toContain('https://react.dev/x#useeffect');
    expect(res.content).toContain('Signature: useEffect(setup, dependencies?)');
  });

  it('passes scope + project_id through and reports the scoped collections', async () => {
    let seen: Parameters<DocSearchBackend['search']>[0] | null = null;
    setGlobalDocSearch({
      search: async (input) => {
        seen = input;
        return {
          results: [],
          diag: diag({ scope: 'project', scoped_collections: ['react-docs'] }),
        };
      },
    });
    const projectCtx = { projectId: 7 } as ToolContext;
    const res = await ragSearchDocsTool.handler({ query: 'q' }, projectCtx);
    expect(seen).toMatchObject({ scope: 'project', project_id: 7 });
    expect(res.content).toContain('linked collections (react-docs)');
    expect(res.content).toContain('scope:"all"');
  });

  it('honors scope:"all" from the args', async () => {
    let seen: Parameters<DocSearchBackend['search']>[0] | null = null;
    setGlobalDocSearch({
      search: async (input) => {
        seen = input;
        return { results: [], diag: diag({ scope: 'all' }) };
      },
    });
    await ragSearchDocsTool.handler({ query: 'q', scope: 'all' }, ctx);
    expect(seen).toMatchObject({ scope: 'all' });
  });
});
