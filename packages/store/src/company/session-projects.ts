import type { Database as DB } from 'better-sqlite3';
import type { CompanySessionProject } from '@mcp/company/types.js';

export function add(db: DB, companySessionId: number, projectId: number, label?: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO company_session_projects (company_session_id, project_id, label)
    VALUES (?, ?, ?)
  `).run(companySessionId, projectId, label ?? null);
}

/**
 * Unlink a project from a session. Does NOT delete the project row itself —
 * that's the caller's choice (virtual `_builder_*` rows are deleted alongside;
 * external projects are kept for reuse).
 *
 * The link table has no ON DELETE CASCADE toward `projects`, so without this
 * explicit cleanup deleting a service's virtual project leaves an orphan row
 * that shows up as `project-<id>` in the UI.
 */
export function remove(db: DB, companySessionId: number, projectId: number): void {
  db.prepare(
    `DELETE FROM company_session_projects
     WHERE company_session_id = ? AND project_id = ?`,
  ).run(companySessionId, projectId);
}

/**
 * One-shot cleanup for orphan rows — link rows whose `project_id` no longer
 * exists in the `projects` table. Called from the session full read so stale
 * rows from past bugs disappear without a migration that blindly deletes
 * history. Returns the number of rows removed.
 */
export function pruneOrphans(db: DB, companySessionId: number): number {
  // This runs on EVERY `state-snapshot` poll (a hot, high-frequency read path).
  // A bare DELETE takes the WAL write lock and appends a frame even when zero
  // rows match, which under a multi-agent run needlessly contends with the
  // worker writers. Probe with a read first; only take the write path when an
  // orphan actually exists (rare), keeping the steady-state poll read-only.
  const orphan = db.prepare(
    `SELECT 1 FROM company_session_projects
     WHERE company_session_id = ?
       AND project_id NOT IN (SELECT id FROM projects)
     LIMIT 1`,
  ).get(companySessionId);
  if (!orphan) return 0;
  const res = db.prepare(
    `DELETE FROM company_session_projects
     WHERE company_session_id = ?
       AND project_id NOT IN (SELECT id FROM projects)`,
  ).run(companySessionId);
  return res.changes;
}

export function list(db: DB, companySessionId: number): CompanySessionProject[] {
  return db
    .prepare('SELECT * FROM company_session_projects WHERE company_session_id = ?')
    .all(companySessionId) as CompanySessionProject[];
}
