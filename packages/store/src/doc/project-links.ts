/**
 * Project ↔ doc-collection links (migration 134).
 *
 * Collections stay global; these rows only SCOPE retrieval. The search
 * backend resolves a session's project to its linked collections and
 * filters the hybrid search to that subset — no links means the search
 * falls back to the global corpus, so linking is purely additive.
 */
import type { Database as DB } from 'better-sqlite3';
import type { DocCollection, DocProjectLink, DocProjectLinkOrigin } from './types.js';
import { mapCollection } from './mappers.js';

/**
 * Idempotent link. Returns true when a new row was inserted, false when the
 * pair already existed (origin of an existing row is NOT overwritten — the
 * first link wins, so a manual link isn't demoted to 'auto' by a later
 * suggestion approval).
 */
export function link(
  db: DB,
  projectId: number,
  collectionId: number,
  origin: DocProjectLinkOrigin = 'manual',
): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO project_doc_collections (project_id, collection_id, origin)
       VALUES (?, ?, ?)`,
    )
    .run(projectId, collectionId, origin);
  return result.changes > 0;
}

export function unlink(db: DB, projectId: number, collectionId: number): boolean {
  const result = db
    .prepare(
      'DELETE FROM project_doc_collections WHERE project_id = ? AND collection_id = ?',
    )
    .run(projectId, collectionId);
  return result.changes > 0;
}

export function listCollectionsForProject(db: DB, projectId: number): DocCollection[] {
  const rows = db
    .prepare(
      `SELECT c.*
         FROM doc_collections c
         JOIN project_doc_collections pdc ON pdc.collection_id = c.id
        WHERE pdc.project_id = ?
        ORDER BY c.name`,
    )
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map(mapCollection);
}

/**
 * Batched form of `listCollectionsForProject`. Admin surfaces ask for every
 * project at once (`GET /api/projects/semantic/status`), and calling the
 * single-project query in a loop puts N synchronous SQLite round-trips on the
 * Electron main thread in one burst. One query, grouped in JS instead.
 *
 * Chunked because SQLite caps bound parameters (999 on older builds) and the
 * project count is caller-controlled.
 */
export function listCollectionsForProjects(
  db: DB,
  projectIds: readonly number[],
): Map<number, DocCollection[]> {
  const out = new Map<number, DocCollection[]>();
  for (const id of projectIds) out.set(id, []);
  const unique = [...new Set(projectIds)];
  for (let i = 0; i < unique.length; i += 900) {
    const chunk = unique.slice(i, i + 900);
    const rows = db
      .prepare(
        `SELECT c.*, pdc.project_id AS __project_id
           FROM doc_collections c
           JOIN project_doc_collections pdc ON pdc.collection_id = c.id
          WHERE pdc.project_id IN (${chunk.map(() => '?').join(',')})
          ORDER BY c.name`,
      )
      .all(...chunk) as Array<Record<string, unknown>>;
    for (const row of rows) {
      out.get(Number(row.__project_id))?.push(mapCollection(row));
    }
  }
  return out;
}

export function listProjectsForCollection(db: DB, collectionId: number): DocProjectLink[] {
  const rows = db
    .prepare(
      `SELECT pdc.project_id, p.name AS project_name, pdc.origin, pdc.created_at
         FROM project_doc_collections pdc
         JOIN projects p ON p.id = pdc.project_id
        WHERE pdc.collection_id = ?
        ORDER BY p.name`,
    )
    .all(collectionId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    project_id: row.project_id as number,
    project_name: row.project_name as string,
    origin: row.origin as DocProjectLinkOrigin,
    created_at: row.created_at as string,
  }));
}
