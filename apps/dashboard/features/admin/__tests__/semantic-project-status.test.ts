import { describe, expect, it } from 'vitest';
import type {
  ProjectSemanticStatusResult,
  SemanticNamespaceStatusView,
} from '../semantic-api.js';
import {
  summarizeProjectSemanticScopes,
  summarizeProjectVectorStorage,
} from '../semantic-project-status.js';

function namespace(namespace: string, dbPath: string, sizeBytes: number): SemanticNamespaceStatusView {
  return {
    namespace,
    purpose: namespace.startsWith('code:')
      ? 'code'
      : namespace.startsWith('docs:')
        ? 'docs'
        : 'memory',
    dbPath,
    size_bytes: sizeBytes,
    active: null,
    building: null,
    expected_items: 0,
    indexed_items: 0,
    failed_items: 0,
    delta_items: 0,
    last_error: null,
    updated_at: null,
  };
}

describe('project semantic status view model', () => {
  it('maps code, snapshot, and project memory independently', () => {
    const result: ProjectSemanticStatusResult = {
      project: { id: 42, name: 'demo' },
      status: {
        project_id: 42,
        profiles: [],
        namespaces: [
          namespace('memory:project:p42', 'D:/demo/.mcp-indexer/vectors.db', 8192),
          namespace('code:p42', 'D:/demo/.mcp-indexer/vectors.db', 8192),
          namespace('snapshot:p42', 'D:/demo/.mcp-indexer/vectors.db', 8192),
        ],
      },
      error: null,
    };

    const scopes = summarizeProjectSemanticScopes(result);
    expect(scopes.map(({ scope, namespace: id }) => [scope, id])).toEqual([
      ['code', 'code:p42'],
      ['snapshot', 'snapshot:p42'],
      ['project_memory', 'memory:project:p42'],
    ]);
    expect(scopes.every(({ status }) => status !== null)).toBe(true);
  });

  it('counts a shared project vectors.db only once', () => {
    const shared = 'D:/demo/.mcp-indexer/vectors.db';
    const result: ProjectSemanticStatusResult = {
      project: { id: 3, name: 'demo' },
      status: {
        project_id: 3,
        profiles: [],
        namespaces: [
          namespace('code:p3', shared, 12_288),
          namespace('snapshot:p3', shared, 12_288),
          namespace('memory:project:p3', shared, 12_288),
        ],
      },
      error: null,
    };

    const storage = summarizeProjectVectorStorage(summarizeProjectSemanticScopes(result));
    expect(storage).toEqual({ dbPaths: [shared], sizeBytes: 12_288 });
  });

  it('sums only distinct physical paths defensively', () => {
    const scopes = summarizeProjectSemanticScopes({
      project: { id: 5, name: 'fallback' },
      status: {
        project_id: 5,
        profiles: [],
        namespaces: [
          namespace('code:p5', 'D:/one/vectors.db', 10),
          namespace('snapshot:p5', 'D:/one/vectors.db', 12),
          namespace('memory:project:p5', 'D:/two/vectors.db', 7),
        ],
      },
      error: null,
    });

    expect(summarizeProjectVectorStorage(scopes)).toEqual({
      dbPaths: ['D:/one/vectors.db', 'D:/two/vectors.db'],
      sizeBytes: 19,
    });
  });
});
