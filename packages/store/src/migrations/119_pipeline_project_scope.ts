/**
 * Migration 119 — Pipeline project scope.
 *
 * Separates the two pipeline worlds by scope so they stop borrowing each
 * other's definitions:
 *   - **Chat / project (V2)** — a pipeline owned by a single `project`.
 *   - **Company / multi-project (V1)** — a pipeline owned by a
 *     `company_session` (which links N projects).
 *   - **Global** — both owners NULL (shared template).
 *
 * Adds a nullable `project_id` to `pipelines` (the definition) and to
 * `pipeline_executions` (the run). A column-level FK via `ALTER TABLE ADD
 * COLUMN` is safe and cheap; we deliberately do NOT rebuild `pipelines`
 * just to add a table-level CHECK — that table is the parent of two FK
 * children and a rebuild would need `foreign_keys=OFF`. The scope
 * invariant ("at most one of project_id / company_session_id is set") was
 * enforced by the original store layer. Migration 265 later retires these
 * tables while keeping the historical upgrade chain intact.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const pipelineProjectScope119: Migration = {
  version: 119,
  name: 'pipeline_project_scope',
  up(db: DB) {
    db.exec(`
      ALTER TABLE pipelines ADD COLUMN project_id INTEGER
        REFERENCES projects(id) ON DELETE CASCADE;
      ALTER TABLE pipeline_executions ADD COLUMN project_id INTEGER
        REFERENCES projects(id) ON DELETE CASCADE;

      CREATE INDEX IF NOT EXISTS idx_pipelines_project
        ON pipelines(project_id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_exec_project
        ON pipeline_executions(project_id, status);
    `);
  },
};
