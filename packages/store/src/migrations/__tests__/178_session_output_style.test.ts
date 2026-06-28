/**
 * Migration 178 — session_output_style.
 *
 * Pin invariants:
 *   - On a CENTRAL DB (coder_sessions present) up() adds output_style_override
 *     and is idempotent.
 *   - On a PROJECT DB (coder_sessions trimmed away — it is in CENTRAL_DROP_TABLES)
 *     up() is a no-op, NOT a crash. Without the tableExists guard the ALTER threw
 *     `no such table: coder_sessions` and crash-looped the indexer-worker on
 *     upgrade.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { sessionOutputStyle178 } from '../178_session_output_style.js';

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

describe('migration 178 — session_output_style', () => {
  it('no-ops when coder_sessions is absent (trimmed project DB)', () => {
    expect(colNames('coder_sessions')).toEqual([]); // table genuinely absent
    expect(() => sessionOutputStyle178.up(db)).not.toThrow();
    expect(colNames('coder_sessions')).toEqual([]); // still absent — guard creates nothing
  });

  it('adds output_style_override when coder_sessions exists (central DB)', () => {
    db.exec(`CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)`);
    sessionOutputStyle178.up(db);
    expect(colNames('coder_sessions')).toContain('output_style_override');
  });

  it('is idempotent — a second up() run is a no-op', () => {
    db.exec(`CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)`);
    sessionOutputStyle178.up(db);
    expect(() => sessionOutputStyle178.up(db)).not.toThrow();
    expect(colNames('coder_sessions').filter((c) => c === 'output_style_override')).toHaveLength(1);
  });
});
