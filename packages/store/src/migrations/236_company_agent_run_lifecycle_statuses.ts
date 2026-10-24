/**
 * Migration 236 — align company_agent_runs.status with AgentRunStatus.
 *
 * The runtime has long persisted `paused` and marks live runs `interrupted`
 * during boot recovery, but migration 019's CHECK predated both values (and
 * the later waiting variants). Recreate the table without cascading through
 * its dependants, preserving App work-item links and runtime provenance.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const companyAgentRunLifecycleStatuses236: Migration = {
  version: 236,
  name: 'company_agent_run_lifecycle_statuses',
  outsideTransaction: true,
  up(db: DB): void {
    const table = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'company_agent_runs'
    `).get() as { sql: string } | undefined;
    if (!table) return;
    const requiredStatuses = [
      'paused',
      'interrupted',
      'waiting_question',
      'waiting_tasks',
    ];
    if (requiredStatuses.every((status) => table.sql.includes(`'${status}'`))) return;
    const hasAppWorkItemRuns = Boolean(db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_studio_work_item_runs'
    `).get());

    db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(`
          DROP TABLE IF EXISTS company_agent_runs_236_new;
          DROP TRIGGER IF EXISTS trg_company_agent_run_runtime_provenance;
          DROP TRIGGER IF EXISTS trg_app_studio_work_item_run_agent_insert;
          DROP TRIGGER IF EXISTS trg_app_studio_work_item_run_agent_update;

          CREATE TABLE company_agent_runs_236_new (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            company_session_id INTEGER NOT NULL REFERENCES company_sessions(id) ON DELETE CASCADE,
            role               TEXT NOT NULL,
            coder_session_id   INTEGER NOT NULL REFERENCES coder_sessions(id) ON DELETE CASCADE,
            project_ids_json   TEXT NOT NULL DEFAULT '[]',
            provider           TEXT NOT NULL,
            model              TEXT NOT NULL,
            status             TEXT NOT NULL DEFAULT 'idle'
              CHECK(status IN (
                'idle','running','working','waiting','waiting_plan',
                'waiting_question','waiting_tasks','reviewing','blocked',
                'completed','error','aborted','paused','interrupted'
              )),
            status_message     TEXT NOT NULL DEFAULT '',
            created_at         TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
            archive_id         INTEGER REFERENCES company_session_archives(id) ON DELETE SET NULL,
            configured_provider TEXT,
            configured_model    TEXT,
            dispatch_source     TEXT NOT NULL DEFAULT 'company',
            fallback_reason     TEXT
          );

          INSERT INTO company_agent_runs_236_new (
            id, company_session_id, role, coder_session_id, project_ids_json,
            provider, model, status, status_message, created_at, updated_at,
            archive_id, configured_provider, configured_model,
            dispatch_source, fallback_reason
          )
          SELECT
            id, company_session_id, role, coder_session_id, project_ids_json,
            provider, model, status, status_message, created_at, updated_at,
            archive_id, configured_provider, configured_model,
            dispatch_source, fallback_reason
          FROM company_agent_runs;

          DROP TABLE company_agent_runs;
          ALTER TABLE company_agent_runs_236_new RENAME TO company_agent_runs;

          CREATE INDEX IF NOT EXISTS idx_car_session
            ON company_agent_runs(company_session_id);
          CREATE INDEX IF NOT EXISTS idx_agent_runs_archive
            ON company_agent_runs(archive_id);

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
        if (hasAppWorkItemRuns) {
          db.exec(`
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
      });
      tx();

      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(`foreign_key_check failed after company agent-run rebuild (${violations.length} violation(s))`);
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
  },
};
