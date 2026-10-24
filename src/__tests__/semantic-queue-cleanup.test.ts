import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { semanticIndexing227 } from '@mcp/store/migrations/227_semantic_indexing.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
// The maintenance command intentionally bypasses application startup/migrations.
import { cleanupSemanticQueue } from '../../scripts/cleanup-semantic-queue.mjs';

const Database = createRequire(import.meta.url)('better-sqlite3');

describe('semantic queue maintenance', () => {
  it('backs up and removes only redundant paused attempts, preserving fences and latest attempts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'semantic-cleanup-'));
    const dbPath = join(root, 'index.db');
    const db = new Database(dbPath);
    try {
      semanticIndexing227.up(db);
      const store = new SemanticStore(db);
      const generation = store.createGeneration({ purpose: 'memory', fingerprint: 'test',
        embedding_target: { kind: 'disabled' }, dimension: 3, expected_items: 1 });
      const make = (kind: 'build' | 'delta', status: 'paused' | 'pending', namespace = 'memory:user') => {
        const row = store.createJob({ namespace, generation_id: generation.id, kind, expected_items: 1 });
        store.updateJob(row.id, { status });
        return row.id;
      };
      const old = make('build', 'paused');
      const latest = make('build', 'paused');
      const delta = make('delta', 'paused');
      const pending = make('build', 'pending');
      const code = make('build', 'paused', 'code:p1');
      expect(await cleanupSemanticQueue({ dbPath })).toMatchObject({ applied: false, candidates: 1 });
      expect(store.getJob(old)).not.toBeNull();
      const result = await cleanupSemanticQueue({ dbPath, apply: true, backupDir: join(root, 'backup') });
      expect(result).toMatchObject({ applied: true, removed: 1, integrity: 'ok' });
      expect(store.getJob(old)).toBeNull();
      for (const id of [latest, delta, pending, code]) expect(store.getJob(id)).not.toBeNull();
      const backup = new Database(result.backupPath, { readonly: true });
      try { expect(backup.prepare('SELECT COUNT(*) AS n FROM semantic_jobs').get().n).toBe(5); }
      finally { backup.close(); }
      expect(await cleanupSemanticQueue({ dbPath })).toMatchObject({ applied: false, candidates: 0 });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
