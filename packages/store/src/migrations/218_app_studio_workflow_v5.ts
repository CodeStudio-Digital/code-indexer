import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Durable, non-blocking App Studio workflow and Kanban state. */
export const appStudioWorkflowV5218: Migration = {
  version: 218,
  name: 'app_studio_workflow_v5',
  up(db: DB) {
    // App Studio is central-only. Project DBs run this migration lineage after
    // their central tables have been trimmed, so the entire migration must no-op.
    if (!tableExists(db, 'app_studio_sessions')) return;

    addColumnIfMissing(db, 'app_studio_sessions', 'coordinator_session_id', 'INTEGER');

    db.exec(`
      CREATE TABLE IF NOT EXISTS app_studio_workflow_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        source_version INTEGER NOT NULL,
        pipeline_json TEXT,
        workflow_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        restored_at TEXT
      );

      CREATE TABLE IF NOT EXISTS app_studio_delivery_blueprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','approved','superseded')) DEFAULT 'draft',
        blueprint_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at TEXT,
        UNIQUE(app_session_id, revision_number)
      );

      CREATE TABLE IF NOT EXISTS app_studio_work_items (
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

      CREATE TABLE IF NOT EXISTS app_studio_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('scope','blueprint','release')),
        status TEXT NOT NULL CHECK(status IN ('pending','approved','changes_requested','superseded')) DEFAULT 'pending',
        bundle_revision INTEGER NOT NULL,
        bundle_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        feedback TEXT,
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        UNIQUE(app_session_id, type, bundle_revision)
      );

      CREATE TABLE IF NOT EXISTS app_studio_decision_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]',
        blocked_work_item_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('open','resolved')) DEFAULT 'open',
        answer TEXT,
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS app_studio_workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        idempotency_key TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(app_session_id, idempotency_key)
      );

      CREATE INDEX IF NOT EXISTS idx_app_studio_work_items_board
        ON app_studio_work_items(app_session_id, status, sort_order, priority);
      CREATE INDEX IF NOT EXISTS idx_app_studio_work_items_slice
        ON app_studio_work_items(app_session_id, slice_id);
      CREATE INDEX IF NOT EXISTS idx_app_studio_approvals_attention
        ON app_studio_approvals(app_session_id, status, requested_at);
      CREATE INDEX IF NOT EXISTS idx_app_studio_decisions_attention
        ON app_studio_decision_requests(app_session_id, status, requested_at);
      CREATE INDEX IF NOT EXISTS idx_app_studio_workflow_events_session
        ON app_studio_workflow_events(app_session_id, id);
    `);
  },
};
