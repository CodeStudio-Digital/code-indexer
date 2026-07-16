import type { DB } from './types.js';

export interface ProjectHygieneRow {
  id: number;
  name: string;
  root_path: string;
  file_count: number;
  vector_count: number;
  orphan_semantic_items: number;
  stale_runs: number;
  mixed_case_languages: number;
}

export interface OrphanSemanticItem {
  generation_id: number;
  namespace: string;
  item_key: string;
  vector_id: string | null;
}

export function listProjectsHygiene(db: DB): ProjectHygieneRow[] {
  return db.prepare(`
    SELECT
      p.id,
      p.name,
      p.root_path,
      (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id) AS file_count,
      (SELECT COUNT(*) FROM semantic_items i
        WHERE i.namespace IN (
          'code:p' || p.id,
          'snapshot:p' || p.id,
          'memory:project:p' || p.id
        )
      ) AS vector_count,
      (SELECT COUNT(*) FROM semantic_items i
        WHERE i.namespace IN (
          'code:p' || p.id,
          'snapshot:p' || p.id,
          'memory:project:p' || p.id
        ) AND i.generation_id = (
          SELECT COALESCE(ng.building_generation_id, ng.active_generation_id)
          FROM semantic_namespace_generations ng
          WHERE ng.namespace = i.namespace
        ) AND (
          (i.item_key LIKE 'file:%' AND NOT EXISTS (
            SELECT 1 FROM files f
            WHERE f.project_id = p.id
              AND f.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
          )) OR
          ((i.item_key LIKE 'symbol:%' OR i.item_key LIKE 'symbol_body:%' OR i.item_key LIKE 'symbol_group:%')
            AND NOT EXISTS (
              SELECT 1 FROM symbols s
              WHERE s.project_id = p.id
                AND s.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
            )) OR
          (i.item_key LIKE 'snapshot:%' AND NOT EXISTS (
            SELECT 1 FROM snapshots sn
            WHERE sn.project_id = p.id AND sn.archived_at IS NULL
              AND sn.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
          )) OR
          (i.item_key LIKE 'agent_memory:%' AND NOT EXISTS (
            SELECT 1 FROM agent_memory m
            WHERE m.project_id = p.id AND m.archived_at IS NULL
              AND m.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
          )) OR
          (i.item_key LIKE 'investigation:%' AND NOT EXISTS (
            SELECT 1 FROM coder_investigations ci
            WHERE ci.project_id = p.id
              AND ci.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
          ))
        )
      ) AS orphan_semantic_items,
      (SELECT COUNT(*) FROM runs r
        WHERE r.project_id = p.id
          AND r.status = 'running'
          AND r.started_at < datetime('now', '-2 hours')
      ) AS stale_runs,
      (SELECT COUNT(*) FROM files f
        WHERE f.project_id = p.id AND f.language <> LOWER(f.language)
      ) AS mixed_case_languages
    FROM projects p
    ORDER BY p.name
  `).all() as ProjectHygieneRow[];
}

export function listOrphanSemanticItems(db: DB, projectId: number): OrphanSemanticItem[] {
  const namespaces = [`code:p${projectId}`, `snapshot:p${projectId}`, `memory:project:p${projectId}`];
  const rows = db.prepare(`
    SELECT i.generation_id, i.namespace, i.item_key, i.vector_id
    FROM semantic_items i
    WHERE i.namespace IN (?, ?, ?)
      AND i.generation_id = (
        SELECT COALESCE(ng.building_generation_id, ng.active_generation_id)
        FROM semantic_namespace_generations ng
        WHERE ng.namespace = i.namespace
      ) AND (
      (i.item_key LIKE 'file:%' AND NOT EXISTS (
        SELECT 1 FROM files f
        WHERE f.project_id = ?
          AND f.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
      )) OR
      ((i.item_key LIKE 'symbol:%' OR i.item_key LIKE 'symbol_body:%' OR i.item_key LIKE 'symbol_group:%')
        AND NOT EXISTS (
          SELECT 1 FROM symbols s
          WHERE s.project_id = ?
            AND s.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
        )) OR
      (i.item_key LIKE 'snapshot:%' AND NOT EXISTS (
        SELECT 1 FROM snapshots sn
        WHERE sn.project_id = ? AND sn.archived_at IS NULL
          AND sn.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
      )) OR
      (i.item_key LIKE 'agent_memory:%' AND NOT EXISTS (
        SELECT 1 FROM agent_memory m
        WHERE m.project_id = ? AND m.archived_at IS NULL
          AND m.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
      )) OR
      (i.item_key LIKE 'investigation:%' AND NOT EXISTS (
        SELECT 1 FROM coder_investigations ci
        WHERE ci.project_id = ?
          AND ci.id = CAST(substr(i.item_key, instr(i.item_key, ':') + 1) AS INTEGER)
      ))
    )
    ORDER BY i.namespace, i.item_key, i.chunk_index
  `).all(...namespaces, projectId, projectId, projectId, projectId, projectId) as OrphanSemanticItem[];
  return rows;
}

/**
 * In-degree per file path — how many other files in this project import it.
 * Built from file_dependencies; reflects the previous indexing run.
 * Used by the auto-mapper to promote heavily-imported files from support→core.
 */
export function getFileIndegrees(db: DB, projectId: number): Map<string, number> {
  const rows = db.prepare(`
    SELECT f.path AS path, COUNT(*) AS indegree
    FROM file_dependencies fd
    JOIN files f ON f.id = fd.target_file_id
    WHERE fd.project_id = ? AND fd.target_file_id IS NOT NULL
    GROUP BY f.path
  `).all(projectId) as Array<{ path: string; indegree: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.path, r.indegree);
  return out;
}

export function getProjectTierBreakdown(db: DB): Array<{ project_id: number; tier: string; count: number }> {
  return db.prepare(`
    SELECT project_id, COALESCE(index_tier, 'untagged') AS tier, COUNT(*) AS count
    FROM files
    GROUP BY project_id, tier
  `).all() as Array<{ project_id: number; tier: string; count: number }>;
}

export function normalizeFileLanguages(db: DB, projectId?: number): number {
  const stmt = projectId != null
    ? db.prepare(
        `UPDATE files SET language = LOWER(language)
          WHERE language <> LOWER(language) AND project_id = ?`,
      )
    : db.prepare(
        `UPDATE files SET language = LOWER(language)
          WHERE language <> LOWER(language)`,
      );
  const result = projectId != null ? stmt.run(projectId) : stmt.run();
  return result.changes;
}

export function markStaleRuns(db: DB, olderThanHours = 2, projectId?: number): number {
  const sql = `
    UPDATE runs
    SET status = 'abandoned',
        finished_at = COALESCE(finished_at, datetime('now'))
    WHERE status = 'running'
      AND started_at < datetime('now', '-' || ? || ' hours')
      ${projectId != null ? 'AND project_id = ?' : ''}
  `;
  const stmt = db.prepare(sql);
  const result = projectId != null ? stmt.run(olderThanHours, projectId) : stmt.run(olderThanHours);
  return result.changes;
}
