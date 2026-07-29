import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../context.js';
import { searchTools } from '../search.js';

const tool = searchTools.find((candidate) => candidate.name === 'search')!;
const project = { id: 7, name: 'demo', root_path: 'D:/demo' };
const result = {
  id: 4,
  type: 'file' as const,
  score: 0.8,
  fts_rank: null,
  vector_score: 0.8,
  data: {
    path: 'src/router.ts', language: 'typescript', line_count: 20,
    complexity: 1, layer: 'service', summary: 'routes semantic vectors', concepts: '[]',
  },
};

function context(remoteOk: boolean) {
  const searchProject = vi.fn(async () => remoteOk
    ? {
        ok: true, error: null,
        value: {
          results: [result],
          diagnostics: { vectorAvailable: true, embeddingAvailable: true, vectorRawMatches: 1 },
        },
      }
    : { ok: false, error: 'connection refused', value: null });
  const searchWithDiag = vi.fn(async () => ({
    results: [{ ...result, score: 0.1, vector_score: null, fts_rank: 1 }],
    diagnostics: { vectorAvailable: false, embeddingAvailable: false, ftsCount: 1 },
  }));
  const db = {
    getProjectByName: () => project,
    getEmbeddingCoverage: () => ({ files_total: 1, files_embedded: 1 }),
    countSemanticStale: () => 0,
  };
  return {
    ctx: {
      db,
      semanticSearchClient: { searchProject },
      hybridSearch: { searchWithDiag },
    } as unknown as ToolContext,
    searchProject,
    searchWithDiag,
  };
}

describe('mcp search semantic delegation', () => {
  it('uses the HTTP owner for hybrid/vector/auto queries', async () => {
    const h = context(true);
    const output = await tool.handler({ project_name: 'demo', query: 'vector routing', mode: 'hybrid' }, h.ctx);

    expect(h.searchProject).toHaveBeenCalledWith(7, 'vector routing', {
      mode: 'hybrid',
      type: 'all',
      limit: 20,
      consumer: 'agent',
      sessionId: undefined,
      companySessionId: undefined,
    });
    expect(h.searchWithDiag).not.toHaveBeenCalled();
    expect(output).toContain('src/router.ts');
  });

  it('forwards the hidden bridge session scope to the semantic owner', async () => {
    const h = context(true);
    await tool.handler({
      project_name: 'demo',
      query: 'vector routing',
      __mcp_session_id: 'session-7',
      __mcp_company_session_id: 'company-3',
    }, h.ctx);

    expect(h.searchProject).toHaveBeenCalledWith(
      7,
      'vector routing',
      expect.objectContaining({
        consumer: 'agent',
        sessionId: 'session-7',
        companySessionId: 'company-3',
      }),
    );
  });

  it('falls back to local FTS and reports the degradation when the owner is offline', async () => {
    const h = context(false);
    const output = await tool.handler({ project_name: 'demo', query: 'vector routing', mode: 'hybrid' }, h.ctx);

    expect(h.searchWithDiag).toHaveBeenCalledWith(7, 'demo', 'vector routing', {
      mode: 'fts', type: 'all', limit: 20,
    });
    expect(output).toContain('FTS-only');
    expect(output).toContain('connection refused');
  });

  it('keeps explicit FTS local and never calls the semantic owner', async () => {
    const h = context(true);
    await tool.handler({ project_name: 'demo', query: 'LocalVectorRouter', mode: 'fts' }, h.ctx);
    expect(h.searchProject).not.toHaveBeenCalled();
    expect(h.searchWithDiag).toHaveBeenCalled();
  });
});
