import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../context.js';
import { symbolTools } from '../symbols.js';

const tool = symbolTools.find((candidate) => candidate.name === 'semantic_neighbors')!;

function fixture(options: { remoteError?: string; vectorError?: string } = {}) {
  const seed = {
    id: 10, project_id: 7, name: 'seed', kind: 'function',
    signature: 'seed(): void', comment: 'does useful work',
    file_path: 'src/seed.ts', line: 3,
  };
  const neighbor = {
    ...seed, id: 11, name: 'neighbor', file_path: 'src/neighbor.ts', line: 8,
  };
  const searchProject = vi.fn(async () => options.remoteError
    ? { ok: false, value: null, error: options.remoteError }
    : {
        ok: true,
        error: null,
        value: {
          results: [{
            id: 11, type: 'symbol', score: 0.9, fts_rank: null,
            vector_score: options.vectorError ? null : 0.9, data: neighbor,
          }],
          diagnostics: {
            vectorAvailable: true,
            embeddingAvailable: true,
            ...(options.vectorError ? { vectorError: options.vectorError } : {}),
          },
        },
      });
  const ftsFallback = vi.fn(async () => ({
    results: [{
      id: 11, type: 'symbol', score: 0.1, fts_rank: 1,
      vector_score: null, data: neighbor,
    }],
    diagnostics: { vectorAvailable: false, embeddingAvailable: false, ftsCount: 1 },
  }));
  const db = {
    getProjectByName: () => ({ id: 7, name: 'renamed-demo', root_path: 'D:/demo' }),
    getProject: () => ({ id: 7, name: 'renamed-demo', root_path: 'D:/demo' }),
    getSymbolById: (id: number) => id === 10 ? seed : id === 11 ? neighbor : undefined,
  };
  return {
    ctx: {
      db,
      semanticSearchClient: { searchProject },
      hybridSearch: { searchWithDiag: ftsFallback },
    } as unknown as ToolContext,
    searchProject,
    ftsFallback,
  };
}

describe('semantic_neighbors server ownership', () => {
  it('delegates semantic work to the localhost owner using the stable project id', async () => {
    const h = fixture();
    const output = await tool.handler({ symbol_id: 10, project_name: 'renamed-demo' }, h.ctx);

    expect(h.searchProject).toHaveBeenCalledWith(7, expect.stringContaining('function seed'), {
      mode: 'hybrid', type: 'symbols', limit: 12,
    });
    expect(h.ftsFallback).not.toHaveBeenCalled();
    expect(output).toContain('neighbor');
    expect(output).not.toContain('lexical fallback');
  });

  it('uses local FTS without opening vectors when the server is offline', async () => {
    const h = fixture({ remoteError: 'connection refused' });
    const output = await tool.handler({ symbol_id: 10, project_name: 'renamed-demo' }, h.ctx);

    expect(h.ftsFallback).toHaveBeenCalledWith(7, 'renamed-demo', expect.any(String), {
      mode: 'fts', type: 'symbols', limit: 12,
    });
    expect(output).toContain('lexical fallback');
    expect(output).toContain('neighbor');
  });

  it('labels server-side FTS fallback when no active generation is available', async () => {
    const h = fixture({ vectorError: 'No active semantic generation for code:p7' });
    const output = await tool.handler({ symbol_id: 10, project_name: 'renamed-demo' }, h.ctx);

    expect(output).toContain('lexical fallback');
    expect(output).toContain('No active semantic generation');
  });
});
