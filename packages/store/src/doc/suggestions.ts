import type { Database as DB } from 'better-sqlite3';
import type { DocSourceSuggestion, DocSuggestionStatus } from './types.js';

export interface UpsertSuggestionInput {
  project_id: number;
  package_manager: string;
  package_name: string;
  package_version?: string | null;
  suggested_url: string;
  suggested_title?: string | null;
  confidence?: number;
}

/**
 * Insert (or skip-if-exists) a single suggestion. Returns true when a new
 * row landed; false when the UNIQUE (project_id, package_manager,
 * package_name) constraint blocked the insert.
 */
export function upsert(db: DB, input: UpsertSuggestionInput): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO doc_source_suggestions (
         project_id, package_manager, package_name, package_version,
         suggested_url, suggested_title, confidence
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.project_id,
      input.package_manager,
      input.package_name,
      input.package_version ?? null,
      input.suggested_url,
      input.suggested_title ?? null,
      input.confidence ?? 0.5,
    );
  return Number(result.changes) > 0;
}

export function list(
  db: DB,
  opts: { projectId: number; status?: DocSuggestionStatus },
): DocSourceSuggestion[] {
  const where: string[] = ['project_id = @projectId'];
  const params: Record<string, unknown> = { projectId: opts.projectId };
  if (opts.status) {
    where.push('status = @status');
    params.status = opts.status;
  }
  return db
    .prepare(
      `SELECT * FROM doc_source_suggestions
         WHERE ${where.join(' AND ')}
         ORDER BY confidence DESC, discovered_at DESC, id DESC`,
    )
    .all(params) as DocSourceSuggestion[];
}

export function get(db: DB, id: number): DocSourceSuggestion | null {
  const row = db
    .prepare('SELECT * FROM doc_source_suggestions WHERE id = ?')
    .get(id) as DocSourceSuggestion | undefined;
  return row ?? null;
}

export function setStatus(
  db: DB,
  id: number,
  status: DocSuggestionStatus,
  indexedSourceId?: number | null,
): void {
  db
    .prepare(
      `UPDATE doc_source_suggestions
          SET status            = ?,
              decided_at        = datetime('now'),
              indexed_source_id = ?
        WHERE id = ?`,
    )
    .run(status, indexedSourceId ?? null, id);
}

export function del(db: DB, id: number): boolean {
  const result = db.prepare('DELETE FROM doc_source_suggestions WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}
