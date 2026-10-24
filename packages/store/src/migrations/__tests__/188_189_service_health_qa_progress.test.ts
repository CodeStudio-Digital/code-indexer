/**
 * Migrations 188 + 189 — service health/transitions/logs + QA run progress.
 *
 * Pin invariants:
 *   - The historical schema at 189 contains the new columns, tables and indexes.
 *   - The current full runner retires these session tables at the filesystem cutover.
 *   - On a trimmed PROJECT DB (company_sandbox_services / qa_test_runs are
 *     in CENTRAL_DROP_TABLES) the ALTERs no-op instead of crashing — the
 *     migration-175 convention (see project-db/trim/drop-list.ts).
 *   - Both migrations are idempotent (re-running up() is a no-op).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { CodeIndexDB } from '../../db.js';
import { getSchemaVersion, MIGRATIONS } from '../index.js';
import { initSchema } from '../../db/schema/index.js';
import { serviceHealthTransitionsLogs188 } from '../188_service_health_transitions_logs.js';
import { qaRunProgressAndErrorClass189 } from '../189_qa_run_progress_and_error_class.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function colNames(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function hasTable(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

function hasIndex(db: DB, index: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(index);
}

describe('migrations 188+189 — historical schema and current cutover', () => {
  let dir: string;
  let db: CodeIndexDB;
  let historical: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-mig-188-189-test-'));
    db = new CodeIndexDB(join(dir, 'test.db')); // constructor runs the full lineage
    historical = new Database(':memory:');
    initSchema(historical);
    historical.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
      if (migration.version > 189) break;
      migration.up(historical);
      historical.prepare('INSERT INTO schema_version (version, name) VALUES (?, ?)').run(migration.version, migration.name);
    }
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    historical.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('lands at schema version >= 189', () => {
    expect(getSchemaVersion(db.raw())).toBeGreaterThanOrEqual(189);
  });

  it('adds the health columns to company_sandbox_services (mig 188)', () => {
    const cols = colNames(historical, 'company_sandbox_services');
    expect(cols).toContain('health');
    expect(cols).toContain('health_detail');
    expect(cols).toContain('last_health_at_ms');
    expect(cols).toContain('restart_count');
  });

  it('creates the transitions + logs tables with their indexes (mig 188)', () => {
    expect(hasTable(historical, 'company_service_transitions')).toBe(true);
    expect(hasTable(historical, 'company_service_logs')).toBe(true);
    expect(hasIndex(historical, 'idx_company_service_transitions_session')).toBe(true);
    expect(hasIndex(historical, 'idx_company_service_logs_session')).toBe(true);
    expect(colNames(historical, 'company_service_transitions')).toEqual(
      ['id', 'session_id', 'service_id', 'kind', 'from_state', 'to_state', 'reason', 'actor', 'at_ms'],
    );
    expect(colNames(historical, 'company_service_logs')).toEqual(
      ['id', 'session_id', 'service_id', 'stream', 'line', 'at_ms'],
    );
  });

  it('adds the progress columns to qa_test_runs (mig 189)', () => {
    const cols = colNames(historical, 'qa_test_runs');
    expect(cols).toContain('error_class');
    expect(cols).toContain('last_event_at');
    expect(cols).toContain('plan_gate');
  });

  it('retires the historical session health and QA schema in the current database', () => {
    for (const table of ['company_sandbox_services', 'company_service_transitions', 'company_service_logs', 'qa_test_runs']) {
      expect(hasTable(db.raw(), table)).toBe(false);
    }
  });
});

describe('migrations 188+189 — trimmed project-DB guards + idempotency', () => {
  let raw: DB;

  beforeEach(() => {
    raw = new Database(':memory:');
  });

  afterEach(() => {
    raw.close();
  });

  it('188 no-ops the ALTERs when company_sandbox_services is absent', () => {
    expect(() => serviceHealthTransitionsLogs188.up(raw)).not.toThrow();
    expect(hasTable(raw, 'company_sandbox_services')).toBe(false); // guard creates nothing
    // The standalone tables are still created (harmless on a project DB —
    // they are in CENTRAL_DROP_TABLES and get trimmed).
    expect(hasTable(raw, 'company_service_transitions')).toBe(true);
    expect(hasTable(raw, 'company_service_logs')).toBe(true);
  });

  it('189 no-ops when qa_test_runs is absent', () => {
    expect(() => qaRunProgressAndErrorClass189.up(raw)).not.toThrow();
    expect(hasTable(raw, 'qa_test_runs')).toBe(false);
  });

  it('188 is idempotent when the table exists', () => {
    raw.exec(`CREATE TABLE company_sandbox_services (session_id INTEGER, service_id TEXT)`);
    serviceHealthTransitionsLogs188.up(raw);
    expect(() => serviceHealthTransitionsLogs188.up(raw)).not.toThrow();
    expect(colNames(raw, 'company_sandbox_services').filter((c) => c === 'health')).toHaveLength(1);
  });

  it('188 seeds health defaults on pre-existing rows', () => {
    raw.exec(`CREATE TABLE company_sandbox_services (session_id INTEGER, service_id TEXT)`);
    raw.exec(`INSERT INTO company_sandbox_services (session_id, service_id) VALUES (1, 'api')`);
    serviceHealthTransitionsLogs188.up(raw);
    const row = raw.prepare(`SELECT health, restart_count FROM company_sandbox_services`).get() as
      { health: string; restart_count: number };
    expect(row.health).toBe('unknown');
    expect(row.restart_count).toBe(0);
  });

  it('189 is idempotent when the table exists', () => {
    raw.exec(`CREATE TABLE qa_test_runs (id INTEGER PRIMARY KEY)`);
    qaRunProgressAndErrorClass189.up(raw);
    expect(() => qaRunProgressAndErrorClass189.up(raw)).not.toThrow();
    expect(colNames(raw, 'qa_test_runs').filter((c) => c === 'error_class')).toHaveLength(1);
  });
});
