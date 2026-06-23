/**
 * Migration 109 — reranker_configs.
 *
 * Pin invariants:
 *   - Table exists with the admin-config columns (mirrors embedding_configs).
 *   - Idempotent — second `up()` run is a no-op.
 *   - provider/reranker.ts CRUD: upsert round-trips, getDefault honors the
 *     (is_default=1 AND enabled=1) filter, and setting a new default clears
 *     the previous one (single-default invariant).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { rerankerConfigs109 } from '../109_reranker_configs.js';
import * as reranker from '../../provider/reranker.js';

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

  it('upsert round-trips and parses the config JSON blob', () => {
    reranker.upsert(db, {
      id: 'cohere',
      kind: 'cohere',
      name: 'Cohere Rerank',
      enabled: true,
      is_default: true,
      config: { apiKey: 'co-test', model: 'rerank-v3.5' },
    });
    const rows = reranker.list(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('cohere');
    expect(rows[0].config).toEqual({ apiKey: 'co-test', model: 'rerank-v3.5' });
    expect(rows[0].enabled).toBe(true);
  });

  it('getDefault returns only the enabled default; null otherwise', () => {
    reranker.upsert(db, { id: 'r1', kind: 'cloudflare', name: 'CF', enabled: false, is_default: true, config: { workerUrl: 'x' } });
    // is_default but disabled → not returned.
    expect(reranker.getDefault(db)).toBeNull();

    reranker.upsert(db, { id: 'r1', kind: 'cloudflare', name: 'CF', enabled: true, is_default: true, config: { workerUrl: 'x' } });
    expect(reranker.getDefault(db)?.id).toBe('r1');
  });

  it('setting a new default clears the previous one', () => {
    reranker.upsert(db, { id: 'a', kind: 'cohere', name: 'A', enabled: true, is_default: true, config: {} });
    reranker.upsert(db, { id: 'b', kind: 'cloudflare', name: 'B', enabled: true, is_default: true, config: {} });
    const rows = reranker.list(db);
    const defaults = rows.filter((r) => r.is_default).map((r) => r.id);
    expect(defaults).toEqual(['b']);
  });
});
