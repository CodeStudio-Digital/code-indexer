/**
 * Migration 191 — retire `company_session_databases` (+ purge its plaintext envs).
 *
 * Pin invariants:
 *   - Runner-driven on an old (040-like) schema: envs MAPPED by a database
 *     row's `env_keys_json` are deleted from `company_session_envs`; envs NOT
 *     mapped (other keys, other sessions) survive; the table is dropped and
 *     `db_query_history.source` appears.
 *   - Trimmed project-DB guards: absent tables → up() no-ops, never throws.
 *   - Idempotent: re-running up() is a no-op.
 *   - Full lineage (CodeIndexDB boot) lands ≥ 191 without the table.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { CodeIndexDB } from '../../db.js';
import { MIGRATIONS, getSchemaVersion, runMigrations } from '../index.js';
import { retireCompanySessionDatabases191 } from '../191_retire_company_session_databases.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasTable(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function colNames(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function envKeys(db: DB, sessionId: number): string[] {
  return (db.prepare(`SELECT key FROM company_session_envs WHERE session_id = ? ORDER BY key`)
    .all(sessionId) as Array<{ key: string }>).map((r) => r.key);
}

/** Old-schema slice: 036 envs + 040 databases + 174 history (pre-191 shape). */
function seedOldSchema(db: DB): void {
  db.exec(`
    CREATE TABLE company_session_envs (
      session_id INTEGER NOT NULL, key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '', is_secret INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, key)
    );
    CREATE TABLE company_session_databases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
      label TEXT NOT NULL, provider TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0, env_keys_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE db_query_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, sql TEXT NOT NULL
    );
  `);
  const env = db.prepare(`INSERT INTO company_session_envs (session_id, key, value) VALUES (?, ?, ?)`);
  env.run(1, 'DATABASE_URL', 'postgres://user:secret@host/db'); // mapped → purged
  env.run(1, 'DB_PASSWORD', 'secret');                          // mapped → purged
  env.run(1, 'API_KEY', 'keep-me');                             // unmapped → survives
  env.run(2, 'DATABASE_URL', 'keep-other-session');             // other session → survives
  db.prepare(
    `INSERT INTO company_session_databases (session_id, label, provider, env_keys_json) VALUES (?, ?, ?, ?)`,
  ).run(1, 'main', 'postgres', JSON.stringify({ url: 'DATABASE_URL', password: 'DB_PASSWORD' }));
}

describe('migration 191 — runner-driven purge on an old schema', () => {
  let raw: DB;

  beforeEach(() => {
    raw = new Database(':memory:');
    seedOldSchema(raw);
    // Mark every migration except 191 as applied so the REAL runner applies
    // exactly the one under test against the hand-built old schema.
    raw.exec(`CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const mark = raw.prepare(`INSERT INTO schema_version (version, name) VALUES (?, ?)`);
    for (const m of MIGRATIONS) if (m.version !== 191) mark.run(m.version, m.name);
  });

  afterEach(() => raw.close());

  it('applies only 191, purges mapped envs, keeps the rest, drops the table', () => {
    const { applied } = runMigrations(raw);
    expect(applied).toEqual([191]);
    expect(envKeys(raw, 1)).toEqual(['API_KEY']); // DATABASE_URL + DB_PASSWORD purged
    expect(envKeys(raw, 2)).toEqual(['DATABASE_URL']); // other session untouched
    expect(hasTable(raw, 'company_session_databases')).toBe(false);
    expect(colNames(raw, 'db_query_history')).toContain('source');
  });

  it('tolerates corrupt env_keys_json (purges nothing for that row)', () => {
    raw.prepare(
      `INSERT INTO company_session_databases (session_id, label, provider, env_keys_json) VALUES (?, ?, ?, ?)`,
    ).run(2, 'broken', 'mysql', '{not json');
    runMigrations(raw);
    expect(envKeys(raw, 2)).toEqual(['DATABASE_URL']); // corrupt map → row skipped
    expect(hasTable(raw, 'company_session_databases')).toBe(false);
  });
});

describe('migration 191 — trimmed project-DB guards + idempotency', () => {
  let raw: DB;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => raw.close());

  it('no-ops on an empty DB (both tables absent)', () => {
    expect(() => retireCompanySessionDatabases191.up(raw)).not.toThrow();
    expect(hasTable(raw, 'company_session_databases')).toBe(false);
    expect(hasTable(raw, 'db_query_history')).toBe(false); // guard creates nothing
  });

  it('drops the table even when company_session_envs is absent', () => {
    raw.exec(`CREATE TABLE company_session_databases (
      id INTEGER PRIMARY KEY, session_id INTEGER, env_keys_json TEXT NOT NULL DEFAULT '{}'
    )`);
    expect(() => retireCompanySessionDatabases191.up(raw)).not.toThrow();
    expect(hasTable(raw, 'company_session_databases')).toBe(false);
  });

  it('is idempotent (second up() is a no-op)', () => {
    seedOldSchema(raw);
    retireCompanySessionDatabases191.up(raw);
    expect(() => retireCompanySessionDatabases191.up(raw)).not.toThrow();
    expect(colNames(raw, 'db_query_history').filter((c) => c === 'source')).toHaveLength(1);
  });
});

describe('migration 191 — full lineage on a fresh DB', () => {
  let dir: string;
  let db: CodeIndexDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-mig-191-test-'));
    db = new CodeIndexDB(join(dir, 'test.db')); // constructor runs the full lineage
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('lands at >= 191 with the table gone and the history column present', () => {
    expect(getSchemaVersion(db.raw())).toBeGreaterThanOrEqual(191);
    expect(hasTable(db.raw(), 'company_session_databases')).toBe(false);
    expect(colNames(db.raw(), 'db_query_history')).toContain('source');
  });
});
