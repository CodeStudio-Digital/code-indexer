/**
 * Migration 175 — model_context_window_override.
 *
 * Pin invariants:
 *   - On a CENTRAL DB (provider_models present) up() adds context_window_overridden
 *     and is idempotent.
 *   - On a PROJECT DB (provider_models trimmed away — it is in CENTRAL_DROP_TABLES)
 *     up() is a no-op, NOT a crash. Without the tableExists guard the ALTER threw
 *     `no such table: provider_models` and crash-looped the indexer-worker on
 *     upgrade (the migration is pending against an already-trimmed DB).
 *
 * The full boot path (initSchema → runMigrations → trim, then a pending mig 175)
 * is exercised in project-db/trim/__tests__/trim.test.ts; this pins the guard in
 * isolation so it stays green independent of the full-schema build.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { modelContextWindowOverride175 } from '../175_model_context_window_override.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function colNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
});

describe('migration 175 — model_context_window_override', () => {
  it('no-ops when provider_models is absent (trimmed project DB)', () => {
    expect(colNames('provider_models')).toEqual([]); // table genuinely absent
    expect(() => modelContextWindowOverride175.up(db)).not.toThrow();
    expect(colNames('provider_models')).toEqual([]); // still absent — guard creates nothing
  });

  it('adds context_window_overridden when provider_models exists (central DB)', () => {
    db.exec(`CREATE TABLE provider_models (provider_id TEXT, model_id TEXT, context_window INTEGER)`);
    modelContextWindowOverride175.up(db);
    expect(colNames('provider_models')).toContain('context_window_overridden');
  });

  it('is idempotent — a second up() run is a no-op', () => {
    db.exec(`CREATE TABLE provider_models (provider_id TEXT, model_id TEXT, context_window INTEGER)`);
    modelContextWindowOverride175.up(db);
    expect(() => modelContextWindowOverride175.up(db)).not.toThrow();
    expect(colNames('provider_models').filter((c) => c === 'context_window_overridden')).toHaveLength(1);
  });
});
