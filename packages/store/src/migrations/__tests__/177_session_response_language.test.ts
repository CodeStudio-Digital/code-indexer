/**
 * Migration 177 — session_response_language.
 *
 * Pin invariants:
 *   - On a CENTRAL DB (coder_sessions present) up() adds both columns and is
 *     idempotent.
 *   - On a PROJECT DB (coder_sessions trimmed away — it is in CENTRAL_DROP_TABLES,
 *     but `projects` is kept) up() does NOT crash: it skips coder_sessions and
 *     still adds projects.default_response_language. Without the per-table
 *     tableExists guard the ALTER threw `no such table: coder_sessions` and
 *     crash-looped the indexer-worker on upgrade.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { sessionResponseLanguage177 } from '../177_session_response_language.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function colNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  // `projects` is a KEPT table — present on both central and project DBs.
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY)`);
});

afterEach(() => {
  db.close();
});

describe('migration 177 — session_response_language', () => {
  it('does not crash when coder_sessions is absent (trimmed project DB), still adds the projects column', () => {
    expect(colNames('coder_sessions')).toEqual([]); // genuinely absent
    expect(() => sessionResponseLanguage177.up(db)).not.toThrow();
    expect(colNames('coder_sessions')).toEqual([]); // still absent — guard creates nothing
    expect(colNames('projects')).toContain('default_response_language'); // kept table still migrated
  });

  it('adds both columns when coder_sessions exists (central DB)', () => {
    db.exec(`CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)`);
    sessionResponseLanguage177.up(db);
    expect(colNames('coder_sessions')).toContain('response_language_override');
    expect(colNames('projects')).toContain('default_response_language');
  });

  it('is idempotent — a second up() run is a no-op', () => {
    db.exec(`CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)`);
    sessionResponseLanguage177.up(db);
    expect(() => sessionResponseLanguage177.up(db)).not.toThrow();
    expect(colNames('coder_sessions').filter((c) => c === 'response_language_override')).toHaveLength(1);
    expect(colNames('projects').filter((c) => c === 'default_response_language')).toHaveLength(1);
  });
});
