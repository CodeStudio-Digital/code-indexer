import type { ProjectStats, Project } from '@mcp/shared/types.js';
import type { DB } from './types.js';

/**
 * @param db        project-scoped handle (files/symbols live in the project DB
 *                  when the tiered-hybrid split routes this project).
 * @param centralDb central handle — `runs` stays CENTRAL (telemetry/stats), so
 *                  the run count must come from there, not the project DB.
 */
export function projectStats(db: DB, centralDb: DB, projectId: number, project: Project | undefined): ProjectStats {
  const fileCounts = db.prepare(`
    SELECT COUNT(*) as file_count, COALESCE(SUM(line_count), 0) as total_lines, COALESCE(SUM(size), 0) as total_size
    FROM files WHERE project_id = ?
  `).get(projectId) as { file_count: number; total_lines: number; total_size: number };

  const symbolCount = db.prepare('SELECT COUNT(*) as cnt FROM symbols WHERE project_id = ?')
    .get(projectId) as { cnt: number };

  const languages = db.prepare(`
    SELECT language, COUNT(*) as cnt FROM files WHERE project_id = ? GROUP BY language ORDER BY cnt DESC
  `).all(projectId) as Array<{ language: string; cnt: number }>;

  const runCount = centralDb.prepare('SELECT COUNT(*) as cnt FROM runs WHERE project_id = ?')
    .get(projectId) as { cnt: number };

  return {
    file_count: fileCounts.file_count,
    symbol_count: symbolCount.cnt,
    languages: Object.fromEntries(languages.map(l => [l.language, l.cnt])),
    total_lines: fileCounts.total_lines,
    total_size: fileCounts.total_size,
    last_indexed: project?.last_indexed ?? null,
    structural_indexed_at: project?.structural_indexed_at ?? null,
    semantic_stale_count: countSemanticBacklog(centralDb, projectId),
    run_count: runCount.cnt,
  };
}

/** Compatibility metric backed by the semantic namespace ledger, not files. */
export function countSemanticBacklog(db: DB, projectId: number): number {
  try {
    const row = db.prepare(`
      SELECT building_generation_id, expected_items, indexed_items, delta_items
      FROM semantic_namespace_generations WHERE namespace = ?
    `).get(`code:p${projectId}`) as {
      building_generation_id: number | null;
      expected_items: number;
      indexed_items: number;
      delta_items: number;
    } | undefined;
    if (!row) return 0;
    const building = row.building_generation_id === null
      ? 0
      : Math.max(0, row.expected_items - row.indexed_items);
    return building + Math.max(0, row.delta_items);
  } catch {
    return 0;
  }
}
