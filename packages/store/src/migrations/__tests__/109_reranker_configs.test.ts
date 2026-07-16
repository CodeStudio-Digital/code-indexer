/**
 * Migration 109 — reranker_configs.
 *
 * Pin invariants:
 *   - Table exists with the admin-config columns (mirrors embedding_configs).
 *   - Idempotent — second `up()` run is a no-op.
 * Migration 233 later removes this retired table; these assertions retain
 * replay coverage for databases that still need to traverse version 109.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { rerankerConfigs109 } from '../109_reranker_configs.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  rerankerConfigs109.up(db);
});

afterEach(() => {
  db.close();
});

describe('migration 109 — reranker_configs', () => {
  it('creates reranker_configs with expected columns', () => {
    const cols = db.prepare(`PRAGMA table_info(reranker_configs)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const n of ['id', 'kind', 'name', 'enabled', 'is_default', 'config', 'updated_at']) {
      expect(names.has(n), `missing column ${n}`).toBe(true);
    }
  });

  it('is idempotent — second up() run is a no-op', () => {
    expect(() => rerankerConfigs109.up(db)).not.toThrow();
  });
});
