import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { appStudioWorkItemIdentity219 } from '../219_app_studio_work_item_identity.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function createWorkItems(primaryKey: string): void {
  db.exec(`
    CREATE TABLE app_studio_sessions (id INTEGER PRIMARY KEY);
    CREATE TABLE app_studio_work_items (
      id TEXT NOT NULL,
      app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK(phase IN ('define','blueprint','build','deliver')),
      slice_id TEXT,
      title TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK(kind IN ('research','plan','contract','implement','verify','release','change')),
      owner_profile TEXT NOT NULL DEFAULT 'coordinator',
      priority INTEGER NOT NULL DEFAULT 2,
      revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('backlog','ready','running','review','done','blocked','stale','cancelled')) DEFAULT 'backlog',
      sort_order INTEGER NOT NULL DEFAULT 0,
      depends_on_json TEXT NOT NULL DEFAULT '[]',
      source_ids_json TEXT NOT NULL DEFAULT '[]',
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      file_scope_json TEXT NOT NULL DEFAULT '[]',
      blocked_reason TEXT,
      run_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      ${primaryKey}
    );
    CREATE INDEX idx_app_studio_work_items_board
      ON app_studio_work_items(app_session_id, status, sort_order, priority);
    CREATE INDEX idx_app_studio_work_items_slice
      ON app_studio_work_items(app_session_id, slice_id);
  `);
}

function primaryKeyColumns(): string[] {
  return (db.prepare('PRAGMA table_info(app_studio_work_items)').all() as Array<{ name: string; pk: number }>)
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

describe('migration 219 — App Studio work-item identity', () => {
  it('upgrades a database that already ran the original migration 218', () => {
    createWorkItems('PRIMARY KEY(id)');
    db.exec(`
      INSERT INTO app_studio_sessions (id) VALUES (1), (2);
      INSERT INTO app_studio_work_items (id, app_session_id, phase, title, kind)
        VALUES ('slice-auth', 1, 'build', 'Authentication', 'implement');
    `);

    appStudioWorkItemIdentity219.up(db);

    expect(primaryKeyColumns()).toEqual(['app_session_id', 'id']);
    expect(db.prepare('SELECT title FROM app_studio_work_items WHERE app_session_id = 1 AND id = ?')
      .get('slice-auth')).toEqual({ title: 'Authentication' });

    const upsert = db.prepare(`
      INSERT INTO app_studio_work_items (id, app_session_id, phase, title, kind)
      VALUES (?, ?, 'build', ?, 'implement')
      ON CONFLICT(app_session_id, id) DO UPDATE SET title = excluded.title
    `);
    expect(() => upsert.run('slice-auth', 2, 'Authentication in another app')).not.toThrow();
    expect(() => upsert.run('slice-auth', 1, 'Updated authentication')).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM app_studio_work_items WHERE id = ?')
      .get('slice-auth')).toEqual({ count: 2 });
  });

  it('is idempotent for databases created with the corrected migration 218', () => {
    createWorkItems('PRIMARY KEY(app_session_id, id)');
    expect(() => appStudioWorkItemIdentity219.up(db)).not.toThrow();
    expect(primaryKeyColumns()).toEqual(['app_session_id', 'id']);
  });

  it('is a no-op for trimmed databases without App Studio tables', () => {
    expect(() => appStudioWorkItemIdentity219.up(db)).not.toThrow();
  });
});
