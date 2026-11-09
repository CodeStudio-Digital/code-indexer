import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../context.js';
import { normalizeMcpToolResult } from '../../tool.js';
import { searchTools, smallSemanticFilePreview } from '../search.js';

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
          diagnostics: { vectorAvailable: true, embeddingAvailable: true, vectorRawMatches: 1, structuralRevision: 'remote:4', structuralRevisionAfter: 'remote:4', structuralRevisionStable: true, effectiveMode: 'hybrid' },
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
  it('adds a bounded preview only for safe small semantic file hits', () => {
    const read = vi.fn(() => 'export const SECURITY = { sessionTtlMs: 1800000 };\n');
    expect(smallSemanticFilePreview('D:/demo', 'src/security.ts', 2, read))
      .toContain('sessionTtlMs');
    expect(smallSemanticFilePreview('D:/demo', 'src/large.ts', 41, read)).toBeNull();
    expect(smallSemanticFilePreview('D:/demo', '../secret.ts', 2, read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps the compact contract focused on natural-language semantic queries', () => {
    expect(tool.description).toContain('natural-language question');
    expect(tool.description).toContain('grep_code for exact identifiers');
    expect(tool.description.length).toBeLessThanOrEqual(150);
  });

  it('uses the HTTP owner for hybrid/vector/auto queries', async () => {
    const h = context(true);
    const output = normalizeMcpToolResult(await tool.handler({ project_name: 'demo', query: 'vector routing', mode: 'hybrid' }, h.ctx));

    expect(h.searchProject).toHaveBeenCalledWith(7, 'vector routing', {
      mode: 'hybrid',
      type: 'all',
      limit: 20,
      consumer: 'agent',
      sessionId: undefined,
      companySessionId: undefined,
    });
    expect(h.searchWithDiag).not.toHaveBeenCalled();
    expect(output.text).toContain('src/router.ts');
    expect(output.text).toContain('vector 0.800');
    expect(output.text).not.toContain('score: 0.800');
    expect(output.structuredContent).toMatchObject({ projectId: 7, absenceConclusive: false,
      freshness: { structuralRevision: 'remote:4', revisionStable: true, snapshot: false }, hits: [{ path: 'src/router.ts' }] });
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
    const output = normalizeMcpToolResult(await tool.handler({ project_name: 'demo', query: 'vector routing', mode: 'hybrid' }, h.ctx));

    expect(h.searchWithDiag).toHaveBeenCalledWith(7, 'demo', 'vector routing', {
      mode: 'fts', type: 'all', limit: 20,
      telemetryContext: { requestId: expect.any(String), consumer: 'agent', sessionId: undefined, companySessionId: undefined },
    });
    expect(output.text).toContain('FTS-only');
    expect(output.text).toContain('connection refused');
  });

  it('keeps explicit FTS local and never calls the semantic owner', async () => {
    const h = context(true);
    const output = normalizeMcpToolResult(await tool.handler({ project_name: 'demo', query: 'LocalVectorRouter', mode: 'fts',
      __mcp_session_id: 'session-7', __mcp_company_session_id: 'company-3' }, h.ctx));
    expect(h.searchProject).not.toHaveBeenCalled();
    expect(h.searchWithDiag).toHaveBeenCalledWith(7, 'demo', 'LocalVectorRouter', expect.objectContaining({
      telemetryContext: { requestId: expect.any(String), consumer: 'agent', sessionId: 'session-7', companySessionId: 'company-3' },
    }));
    expect(output.text).toContain('FTS #1');
    expect(output.text).not.toContain('score: 0.000');
  });
});
