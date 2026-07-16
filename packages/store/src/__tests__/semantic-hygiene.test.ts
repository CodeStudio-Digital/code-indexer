import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import { SemanticStore } from '../semantic-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('semantic hygiene', () => {
  it('reports vectors and source orphans from semantic_items, not vector_ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-semantic-hygiene-'));
    dirs.push(dir);
    const db = new CodeIndexDB(join(dir, 'index.db'));
    const project = db.createProject('p', dir);
    const semantic = new SemanticStore(db.raw());
    try {
      const generation = semantic.createGeneration({
        purpose: 'code',
        fingerprint: 'test',
        embedding_target: {
          kind: 'onnx', model: 'test', pooling: 'mean', normalize: true,
          queryTemplate: '{text}', documentTemplate: '{text}',
        },
        dimension: 2,
      });
      semantic.beginNamespaceGeneration({
        namespace: `code:p${project.id}`,
        purpose: 'code',
        generation_id: generation.id,
        expected_items: 1,
      });
      semantic.upsertItem({
        generation_id: generation.id,
        namespace: `code:p${project.id}`,
        item_key: 'file:999',
        source_hash: 'hash',
        vector_id: 'vector-999',
        chunk_index: 0,
        status: 'indexed',
        attempts: 1,
        error: null,
      });

      const row = db.getProjectsHygiene().find((candidate) => candidate.id === project.id)!;
      expect(row).toMatchObject({
        vector_count: 1,
        orphan_semantic_items: 1,
      });
      expect(db.getOrphanSemanticItems(project.id)).toEqual([
        expect.objectContaining({
          namespace: `code:p${project.id}`,
          item_key: 'file:999',
          vector_id: 'vector-999',
        }),
      ]);
      expect(db.raw().prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vector_ids'`,
      ).get()).toBeUndefined();
    } finally {
      semantic.close();
      db.close();
    }
  });
});
