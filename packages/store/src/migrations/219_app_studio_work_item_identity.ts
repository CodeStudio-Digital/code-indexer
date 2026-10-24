/**
 * Migration 219 — repair App Studio work-item identity on databases that
 * executed the first revision of migration 218.
 *
 * That revision made `id` globally unique. Workflow v5 addresses cards by the
 * stable pair `(app_session_id, id)`, so existing databases must be rebuilt;
 * editing migration 218 alone cannot repair an already-versioned database.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function primaryKeyColumns(db: DB, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>)
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
}

export const appStudioWorkItemIdentity219: Migration = {
  version: 219,
  name: 'app_studio_work_item_identity',
  up(db: DB): void {
    if (!tableExists(db, 'app_studio_work_items')) return;
    if (primaryKeyColumns(db, 'app_studio_work_items').join(',') === 'app_session_id,id') return;

    db.exec(`
      ALTER TABLE app_studio_work_items RENAME TO app_studio_work_items_legacy_219;

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
        PRIMARY KEY(app_session_id, id)
      );

      INSERT INTO app_studio_work_items (
        id, app_session_id, phase, slice_id, title, outcome, kind, owner_profile,
        priority, revision, status, sort_order, depends_on_json, source_ids_json,
        acceptance_json, evidence_json, file_scope_json, blocked_reason, run_json,
        created_at, updated_at
      )
      SELECT
        id, app_session_id, phase, slice_id, title, outcome, kind, owner_profile,
        priority, revision, status, sort_order, depends_on_json, source_ids_json,
        acceptance_json, evidence_json, file_scope_json, blocked_reason, run_json,
        created_at, updated_at
      FROM app_studio_work_items_legacy_219;

      DROP TABLE app_studio_work_items_legacy_219;

      CREATE INDEX idx_app_studio_work_items_board
        ON app_studio_work_items(app_session_id, status, sort_order, priority);
      CREATE INDEX idx_app_studio_work_items_slice
        ON app_studio_work_items(app_session_id, slice_id);
    `);
  },
};
