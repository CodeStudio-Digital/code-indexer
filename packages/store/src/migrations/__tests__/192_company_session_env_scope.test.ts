/**
 * Migration 192 — `company_session_envs.service_scope` (D1).
 *
 * Pin invariants:
 *   - Runner-driven on an old (036-like) schema: the column appears and
 *     pre-existing rows read back NULL (= all services, behavior kept).
 *   - Guarded: absent table → up() no-ops, never throws (trimmed DBs).
 *   - Idempotent: re-running up() adds nothing twice.
 *   - Historical lineage reaches 192 with the column; the current cutover retires the table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { CodeIndexDB } from '../../db.js';
import { initSchema } from '../../db/schema/index.js';
import { MIGRATIONS, getSchemaVersion, runMigrations } from '../index.js';
import { companySessionEnvScope192 } from '../192_company_session_env_scope.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function colNames(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

describe('migration 192 — runner-driven on an old schema', () => {
  let raw: DB;

  beforeEach(() => {
    raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE company_session_envs (
        session_id INTEGER NOT NULL, key TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '', is_secret INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, key)
      );
    `);
    raw.prepare(`INSERT INTO company_session_envs (session_id, key, value) VALUES (1, 'K', 'v')`).run();
    // Mark every migration except 192 as applied so the REAL runner
    // applies exactly the one under test against the hand-built schema.
    raw.exec(`CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const mark = raw.prepare(`INSERT INTO schema_version (version, name) VALUES (?, ?)`);
    for (const m of MIGRATIONS) if (m.version !== 192) mark.run(m.version, m.name);
  });

  afterEach(() => raw.close());

  it('applies only 192; column appears; existing rows read back NULL', () => {
    const { applied } = runMigrations(raw);
    expect(applied).toEqual([192]);
    expect(colNames(raw, 'company_session_envs')).toContain('service_scope');
    const row = raw
      .prepare(`SELECT service_scope FROM company_session_envs WHERE session_id = 1 AND key = 'K'`)
      .get() as { service_scope: string | null };
    expect(row.service_scope).toBeNull();
  });
});

describe('migration 192 — guards + idempotency', () => {
  let raw: DB;

  beforeEach(() => { raw = new Database(':memory:'); });
  afterEach(() => raw.close());

  it('no-ops on an empty DB (table absent)', () => {
    expect(() => companySessionEnvScope192.up(raw)).not.toThrow();
    expect(
      raw.prepare(`SELECT name FROM sqlite_master WHERE name='company_session_envs'`).get(),
    ).toBeUndefined();
  });

  it('is idempotent (second up() is a no-op)', () => {
    raw.exec(`CREATE TABLE company_session_envs (
      session_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (session_id, key)
    )`);
    companySessionEnvScope192.up(raw);
    expect(() => companySessionEnvScope192.up(raw)).not.toThrow();
    expect(colNames(raw, 'company_session_envs').filter((c) => c === 'service_scope')).toHaveLength(1);
  });
});

describe('migration 192 — full lineage on a fresh DB', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-mig-192-test-'));
    db = new CodeIndexDB(join(dir, 'test.db')); // constructor runs the full lineage
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('adds the column at historical version 192', () => {
    const historical = new Database(':memory:');
    try {
      initSchema(historical);
      historical.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
      for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
        if (migration.version > 192) break;
        migration.up(historical);
        historical.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(migration.version, migration.name);
      }
      expect(getSchemaVersion(historical)).toBe(192);
      expect(colNames(historical, 'company_session_envs')).toContain('service_scope');
    } finally {
      historical.close();
    }
  });

  it('retires the session environment table in the current filesystem cutover', () => {
    expect(getSchemaVersion(db.raw())).toBe(Math.max(...MIGRATIONS.map((migration) => migration.version)));
    expect(db.raw().prepare("SELECT name FROM sqlite_master WHERE name = 'company_session_envs'").get()).toBeUndefined();
  });
});
