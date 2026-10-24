/**
 * Migration 235 — App Studio backed by the persistent Company runtime.
 *
 * Central-only schema additions:
 *   - classify Company sessions by runtime kind;
 *   - link one App Studio session to one specialised Company session;
 *   - persist effective/configured model provenance on Company agent runs;
 *   - keep an idempotent attempt history between App work items and Company
 *     agent runs.
 *
 * Project DBs inherit the central migration lineage after central tables have
 * been trimmed. Every mutation is therefore guarded independently.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function columnExists(db: DB, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((entry) => entry.name === column);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const appStudioCompanyRuntime235: Migration = {
  version: 235,
  name: 'app_studio_company_runtime',
  up(db: DB) {
    if (tableExists(db, 'company_sessions')) {
      addColumnIfMissing(
        db,
        'company_sessions',
        'runtime_kind',
        "TEXT NOT NULL DEFAULT 'company' CHECK(runtime_kind IN ('company','app_studio'))",
      );
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_company_sessions_runtime_kind
          ON company_sessions(runtime_kind, updated_at DESC);
      `);
    }

    if (tableExists(db, 'company_agent_runs')) {
      addColumnIfMissing(db, 'company_agent_runs', 'configured_provider', 'TEXT');
      addColumnIfMissing(db, 'company_agent_runs', 'configured_model', 'TEXT');
      addColumnIfMissing(
        db,
        'company_agent_runs',
        'dispatch_source',
        "TEXT NOT NULL DEFAULT 'company'",
      );
      addColumnIfMissing(db, 'company_agent_runs', 'fallback_reason', 'TEXT');
      db.exec(`
        UPDATE company_agent_runs
        SET configured_provider = COALESCE(configured_provider, provider),
            configured_model = COALESCE(configured_model, model),
            dispatch_source = COALESCE(NULLIF(dispatch_source, ''), 'company');

        CREATE TRIGGER IF NOT EXISTS trg_company_agent_run_runtime_provenance
        AFTER INSERT ON company_agent_runs
        WHEN NEW.configured_provider IS NULL OR NEW.configured_model IS NULL
        BEGIN
          UPDATE company_agent_runs
          SET configured_provider = COALESCE(NEW.configured_provider, NEW.provider),
              configured_model = COALESCE(NEW.configured_model, NEW.model)
          WHERE id = NEW.id;
        END;
      `);
    }

    if (tableExists(db, 'app_studio_sessions') && tableExists(db, 'company_sessions')) {
      addColumnIfMissing(
        db,
        'app_studio_sessions',
        'company_session_id',
        'INTEGER REFERENCES company_sessions(id) ON DELETE RESTRICT',
      );
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_app_studio_sessions_company
          ON app_studio_sessions(company_session_id)
          WHERE company_session_id IS NOT NULL;

        CREATE TRIGGER IF NOT EXISTS trg_app_studio_company_kind_insert
        BEFORE INSERT ON app_studio_sessions
        WHEN NEW.company_session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM company_sessions
            WHERE id = NEW.company_session_id AND runtime_kind = 'app_studio'
          )
        BEGIN
          SELECT RAISE(ABORT, 'App Studio requires an app_studio Company session');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_app_studio_company_kind_update
        BEFORE UPDATE OF company_session_id ON app_studio_sessions
        WHEN NEW.company_session_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM company_sessions
            WHERE id = NEW.company_session_id AND runtime_kind = 'app_studio'
          )
        BEGIN
          SELECT RAISE(ABORT, 'App Studio requires an app_studio Company session');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_company_runtime_kind_linked_app
        BEFORE UPDATE OF runtime_kind ON company_sessions
        WHEN NEW.runtime_kind <> 'app_studio'
          AND EXISTS (
            SELECT 1 FROM app_studio_sessions WHERE company_session_id = OLD.id
          )
        BEGIN
          SELECT RAISE(ABORT, 'Cannot change runtime kind of an App Studio team');
        END;
      `);
    }

    if (
      tableExists(db, 'app_studio_sessions')
      && tableExists(db, 'app_studio_work_items')
      && tableExists(db, 'company_agent_runs')
      && tableExists(db, 'coder_sessions')
    ) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_studio_work_item_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          app_session_id INTEGER NOT NULL
            REFERENCES app_studio_sessions(id) ON DELETE CASCADE,
          work_item_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK(attempt > 0),
          role TEXT NOT NULL,
          company_agent_run_id INTEGER
            REFERENCES company_agent_runs(id) ON DELETE SET NULL,
          coder_session_id INTEGER
            REFERENCES coder_sessions(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'claimed'
            CHECK(status IN (
              'claimed','running','waiting','paused','completed','blocked',
              'error','aborted','interrupted','cancelled'
            )),
          runtime_config_hash TEXT,
          idempotency_key TEXT NOT NULL,
          status_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (app_session_id, work_item_id)
            REFERENCES app_studio_work_items(app_session_id, id) ON DELETE CASCADE,
          UNIQUE(app_session_id, work_item_id, attempt),
          UNIQUE(app_session_id, idempotency_key)
        );

        CREATE INDEX IF NOT EXISTS idx_app_studio_work_item_runs_history
          ON app_studio_work_item_runs(app_session_id, work_item_id, attempt DESC);
        CREATE INDEX IF NOT EXISTS idx_app_studio_work_item_runs_agent
          ON app_studio_work_item_runs(company_agent_run_id)
          WHERE company_agent_run_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_app_studio_work_item_runs_active
          ON app_studio_work_item_runs(app_session_id, work_item_id)
          WHERE status IN ('claimed','running','waiting','paused');
        CREATE UNIQUE INDEX IF NOT EXISTS idx_app_studio_work_item_runs_active_agent
          ON app_studio_work_item_runs(company_agent_run_id)
          WHERE company_agent_run_id IS NOT NULL
            AND status IN ('claimed','running','waiting','paused');

        CREATE TRIGGER IF NOT EXISTS trg_app_studio_work_item_run_agent_insert
        BEFORE INSERT ON app_studio_work_item_runs
        WHEN NEW.company_agent_run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM company_agent_runs agent
            JOIN app_studio_sessions app
              ON app.company_session_id = agent.company_session_id
            WHERE app.id = NEW.app_session_id
              AND agent.id = NEW.company_agent_run_id
              AND agent.role = NEW.role
              AND (NEW.coder_session_id IS NULL OR agent.coder_session_id = NEW.coder_session_id)
          )
        BEGIN
          SELECT RAISE(ABORT, 'App work-item run agent does not belong to this team/role');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_app_studio_work_item_run_agent_update
        BEFORE UPDATE OF app_session_id, role, company_agent_run_id, coder_session_id
          ON app_studio_work_item_runs
        WHEN NEW.company_agent_run_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM company_agent_runs agent
            JOIN app_studio_sessions app
              ON app.company_session_id = agent.company_session_id
            WHERE app.id = NEW.app_session_id
              AND agent.id = NEW.company_agent_run_id
              AND agent.role = NEW.role
              AND (NEW.coder_session_id IS NULL OR agent.coder_session_id = NEW.coder_session_id)
          )
        BEGIN
          SELECT RAISE(ABORT, 'App work-item run agent does not belong to this team/role');
        END;
      `);
    }
  },
};
