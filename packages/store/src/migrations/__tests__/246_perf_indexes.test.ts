import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { perfIndexes246 } from '../246_perf_indexes.js';

function indexColumns(db: InstanceType<typeof Database>, index: string): string[] {
  const rows = db.prepare(`PRAGMA index_info('${index}')`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexNames(db: InstanceType<typeof Database>, table: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`)
    .all(table) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('migration 246 - perf indexes', () => {
  it('creates the message-role and session-ordering indexes (idempotent)', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE coder_sessions (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE coder_messages (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL,
        role TEXT NOT NULL
      );
    `);

    perfIndexes246.up(db);
    perfIndexes246.up(db);

    expect(indexColumns(db, 'idx_coder_messages_session_role')).toEqual([
      'session_id',
      'role',
      'id',
    ]);
    expect(indexColumns(db, 'idx_coder_sessions_favorite_updated')).toEqual([
      'is_favorite',
      'updated_at',
    ]);
    // `id DESC` tie-break is load-bearing: getLastUsedProviderModel orders by
    // (updated_at DESC, id DESC) and only stops at the first indexed row when
    // the index carries both columns.
    expect(indexColumns(db, 'idx_coder_sessions_updated')).toEqual(['updated_at', 'id']);
    db.close();
  });

  it('is a no-op on trimmed per-project databases (tables absent)', () => {
    const db = new Database(':memory:');
    expect(() => perfIndexes246.up(db)).not.toThrow();
    db.close();
  });

  it('guards each table independently when only one survives the trim', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE coder_sessions (
        id INTEGER PRIMARY KEY,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );
    `);
    expect(() => perfIndexes246.up(db)).not.toThrow();
    expect(indexNames(db, 'coder_sessions')).toEqual(
      expect.arrayContaining(['idx_coder_sessions_favorite_updated', 'idx_coder_sessions_updated']),
    );
    expect(indexNames(db, 'coder_messages')).toEqual([]);
    db.close();
  });
});
