import type { Database as DB } from 'better-sqlite3';
import type { CoderSessionProject, LinkedProject } from '@mcp/code-agent/sessions/types.js';

/**
 * `coder_session_projects` junction store (migration 152) — the project links
 * of a GLOBAL coder session. Mirrors `packages/store/src/company/session-projects.ts`
 * but keyed on `coder_session_id` and carrying `is_primary`.
 *
 * The primary project is also stored here (with `is_primary = 1`) so the runner
 * reads one table to discover every root; normal (non-global) sessions never
 * have rows here, so all of this is inert for them.
 */

export function add(
  db: DB,
  sessionId: number,
  projectId: number,
  opts: { label?: string | null; isPrimary?: boolean } = {},
): void {
  db.prepare(`
    INSERT OR IGNORE INTO coder_session_projects (coder_session_id, project_id, label, is_primary)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, projectId, opts.label ?? null, opts.isPrimary ? 1 : 0);
}

export function remove(db: DB, sessionId: number, projectId: number): void {
  db.prepare(
    `DELETE FROM coder_session_projects
     WHERE coder_session_id = ? AND project_id = ?`,
  ).run(sessionId, projectId);
}

/**
 * Lazy cleanup of orphan rows — links whose `project_id` no longer exists in
 * `projects` (the junction has no CASCADE toward `projects`, by design, so a
 * deleted project never silently breaks a session). Called on read. Returns the
 * number of rows removed.
 */
export function pruneOrphans(db: DB, sessionId: number): number {
  const res = db.prepare(
    `DELETE FROM coder_session_projects
     WHERE coder_session_id = ?
       AND project_id NOT IN (SELECT id FROM projects)`,
  ).run(sessionId);
  return res.changes;
}

/** Raw junction rows for a session (primary first, then by project_id). */
export function list(db: DB, sessionId: number): CoderSessionProject[] {
  return db
    .prepare(
      `SELECT * FROM coder_session_projects
       WHERE coder_session_id = ?
       ORDER BY is_primary DESC, project_id ASC`,
    )
    .all(sessionId) as CoderSessionProject[];
}

/**
 * Linked projects enriched with name + root_path (joined against `projects`),
 * for the API payload, the UI chip, and the runner's multi-root assembly.
 * Prunes orphans first so stale links never surface. Dead links (project gone)
 * are dropped by the INNER JOIN.
 */
export function listLinked(db: DB, sessionId: number): LinkedProject[] {
  pruneOrphans(db, sessionId);
  const rows = db
    .prepare(
      `SELECT csp.project_id AS project_id,
              p.name         AS name,
              p.root_path    AS root_path,
              csp.is_primary AS is_primary,
              csp.label      AS label
         FROM coder_session_projects csp
         JOIN projects p ON p.id = csp.project_id
        WHERE csp.coder_session_id = ?
        ORDER BY csp.is_primary DESC, csp.project_id ASC`,
    )
    .all(sessionId) as Array<{
      project_id: number;
      name: string;
      root_path: string;
      is_primary: number;
      label: string | null;
    }>;
  return rows.map((r) => ({
    project_id: r.project_id,
    name: r.name,
    root_path: r.root_path,
    is_primary: !!r.is_primary,
    label: r.label,
  }));
}
