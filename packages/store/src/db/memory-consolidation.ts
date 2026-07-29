import type { DB } from './types.js';

/**
 * Project selection for the periodic memory consolidator (Workstream B).
 *
 * A project is a candidate when:
 *   - it has live snapshots to consolidate;
 *   - it CHANGED since the last consolidation — its newest live snapshot is
 *     more recent than the last `consolidation` log row (skip-if-unchanged, so
 *     re-runs over a settled project are no-ops at the scheduler level).
 *
 * Session activity does not live in SQLite. The caller must apply the
 * filesystem catalog's idle/running gate before selecting its bounded batch.
 */
export interface ConsolidationCandidate {
  project_id: number;
  project_name: string;
}

export function listConsolidationCandidates(
  db: DB,
): ConsolidationCandidate[] {
  return db.prepare(`
    SELECT p.id AS project_id, p.name AS project_name
    FROM projects p
    WHERE EXISTS (
      SELECT 1 FROM snapshots s WHERE s.project_id = p.id AND s.archived_at IS NULL
    )
    AND (
      SELECT MAX(s.updated_at) FROM snapshots s
      WHERE s.project_id = p.id AND s.archived_at IS NULL
    ) > COALESCE((
      SELECT MAX(l.created_at) FROM memory_distill_log l
      WHERE l.project_id = p.id AND l.trigger = 'consolidation'
    ), '0000-00-00')
  `).all() as ConsolidationCandidate[];
}
