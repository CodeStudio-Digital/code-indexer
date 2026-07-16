/**
 * App Studio v6 is a deliberate clean cut while the feature is experimental.
 * Existing Apps and App-owned Company teams must be deleted by the user before
 * this migration runs. No v5 payload is copied or interpreted.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

const LEGACY_TABLES = [
  'app_studio_work_item_runs',
  'app_studio_workflow_events',
  'app_studio_decision_requests',
  'app_studio_approvals',
  'app_studio_work_items',
  'app_studio_delivery_blueprints',
  'app_studio_workflow_snapshots',
  'app_studio_build_task_evidence',
  'app_studio_build_groups',
  'app_studio_wireframe_revisions',
  'app_studio_ux_revisions',
  'app_studio_product_revisions',
  'app_studio_pipeline_repairs',
  'app_studio_architecture_revisions',
  'app_studio_evolutions',
  'app_studio_spec_revisions',
  'app_studio_features',
  'app_studio_sessions',
] as const;

export const appStudioV6Reset237: Migration = {
  version: 237,
  name: 'app_studio_v6_reset',
  outsideTransaction: true,
  up(db: DB) {
    // Project DBs do not own App Studio control-plane tables.
    if (!tableExists(db, 'app_studio_sessions')) return;

    const apps = (db.prepare('SELECT COUNT(*) AS n FROM app_studio_sessions').get() as { n: number }).n;
    const appTeams = tableExists(db, 'company_sessions')
      ? (db.prepare("SELECT COUNT(*) AS n FROM company_sessions WHERE runtime_kind = 'app_studio'").get() as { n: number }).n
      : 0;
    if (apps > 0 || appTeams > 0) {
      throw new Error(
        `App Studio v6 requires a clean reset. Delete all Apps and App teams first (apps=${apps}, teams=${appTeams}).`,
      );
    }

    db.pragma('foreign_keys = OFF');
    try {
      db.exec('BEGIN');
      db.exec(`
        DROP TRIGGER IF EXISTS trg_app_studio_company_kind_insert;
        DROP TRIGGER IF EXISTS trg_app_studio_company_kind_update;
        DROP TRIGGER IF EXISTS trg_company_runtime_kind_linked_app;
      `);
      for (const table of LEGACY_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);

      db.exec(`
        CREATE TABLE app_studio_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
          company_session_id INTEGER UNIQUE REFERENCES company_sessions(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          app_slug TEXT NOT NULL,
          stack_profile_id TEXT NOT NULL DEFAULT 'cf-fullstack-v1'
            CHECK(stack_profile_id = 'cf-fullstack-v1'),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE app_studio_plan_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
          revision_number INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','superseded')),
          plan_json TEXT NOT NULL,
          fitness_json TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT 'app_orchestrator',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          approved_at TEXT,
          UNIQUE(app_session_id, revision_number)
        );

        CREATE TABLE app_studio_work_items (
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          plan_revision_id INTEGER NOT NULL REFERENCES app_studio_plan_revisions(id) ON DELETE CASCADE,
          slice_id TEXT,
          title TEXT NOT NULL,
          outcome TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL CHECK(kind IN ('research','plan','contract','implement','verify','release','change')),
          owner_role TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'backlog'
            CHECK(status IN ('backlog','ready','running','review','done','blocked','stale','cancelled')),
          sort_order INTEGER NOT NULL DEFAULT 0,
          depends_on_json TEXT NOT NULL DEFAULT '[]',
          source_ids_json TEXT NOT NULL DEFAULT '[]',
          acceptance_json TEXT NOT NULL DEFAULT '[]',
          evidence_json TEXT NOT NULL DEFAULT '[]',
          file_scope_json TEXT NOT NULL DEFAULT '[]',
          blocked_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY(app_session_id, id)
        );

        CREATE TABLE app_studio_work_item_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_session_id INTEGER NOT NULL,
          work_item_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          role TEXT NOT NULL,
          company_agent_run_id INTEGER REFERENCES company_agent_runs(id) ON DELETE SET NULL,
          coder_session_id INTEGER REFERENCES coder_sessions(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'claimed'
            CHECK(status IN ('claimed','running','waiting','paused','completed','blocked','error','aborted','interrupted','cancelled')),
          runtime_config_hash TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          status_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(app_session_id, work_item_id, attempt),
          FOREIGN KEY(app_session_id, work_item_id)
            REFERENCES app_studio_work_items(app_session_id, id) ON DELETE CASCADE
        );

        CREATE TABLE app_studio_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
          plan_revision_id INTEGER NOT NULL REFERENCES app_studio_plan_revisions(id) ON DELETE CASCADE,
          question TEXT NOT NULL,
          options_json TEXT NOT NULL DEFAULT '[]',
          blocked_work_item_ids_json TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
          answer TEXT,
          requested_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
        );

        CREATE TABLE app_studio_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          idempotency_key TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE app_studio_deployments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_session_id INTEGER NOT NULL REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
          plan_revision_id INTEGER NOT NULL REFERENCES app_studio_plan_revisions(id) ON DELETE RESTRICT,
          status TEXT NOT NULL CHECK(status IN ('publishing','live','failed')),
          url TEXT,
          account TEXT,
          database_id TEXT,
          health_ok INTEGER NOT NULL DEFAULT 0,
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_app_studio_plan_revision
          ON app_studio_plan_revisions(app_session_id, revision_number DESC);
        CREATE INDEX idx_app_studio_work_board
          ON app_studio_work_items(app_session_id, status, sort_order);
        CREATE INDEX idx_app_studio_work_runs
          ON app_studio_work_item_runs(app_session_id, work_item_id, attempt DESC);
        CREATE INDEX idx_app_studio_decisions_open
          ON app_studio_decisions(app_session_id, status, requested_at);
        CREATE UNIQUE INDEX idx_app_studio_event_idempotency
          ON app_studio_events(app_session_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX idx_app_studio_deployments_session
          ON app_studio_deployments(app_session_id, id DESC);

        CREATE TRIGGER trg_app_studio_company_kind_insert
        BEFORE INSERT ON app_studio_sessions
        WHEN NEW.company_session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM company_sessions
            WHERE id = NEW.company_session_id AND runtime_kind = 'app_studio'
          )
        BEGIN
          SELECT RAISE(ABORT, 'App Studio requires an app_studio Company session');
        END;

        CREATE TRIGGER trg_app_studio_company_kind_update
        BEFORE UPDATE OF company_session_id ON app_studio_sessions
        WHEN NEW.company_session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM company_sessions
            WHERE id = NEW.company_session_id AND runtime_kind = 'app_studio'
          )
        BEGIN
          SELECT RAISE(ABORT, 'App Studio requires an app_studio Company session');
        END;
      `);
      db.exec('COMMIT');
      db.pragma('foreign_keys = ON');
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) throw new Error(`foreign_key_check failed (${violations.length} violation(s))`);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
      db.pragma('foreign_keys = ON');
      throw error;
    }
  },
};
