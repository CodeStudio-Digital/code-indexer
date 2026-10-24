/** Per-workspace language-server profile overrides owned by the project DB. */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const projectLspProfileOverrides250: Migration = {
  version: 250,
  name: 'project_lsp_profile_overrides',
  up(db: DB): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_lsp_profile_overrides (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        family_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, family_id, workspace_path)
      );

      CREATE INDEX IF NOT EXISTS idx_project_lsp_profile_overrides_family
        ON project_lsp_profile_overrides(project_id, family_id);
    `);
  },
};
