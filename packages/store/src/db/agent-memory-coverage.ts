import type { DB } from './types.js';

export interface AgentMemoryCoverage {
  namespace: string;
  generationId: number | null;
  live: number;
  indexed: number;
  failed: number;
  missing: number;
  pending: number;
  queuedMutations: number;
}

/** Count live source identities, not chunks or historical namespace totals.
 * This is recorded coverage; physical/hash validation belongs to the worker. */
export function readAgentMemoryCoverage(db: DB, projectId: number, scope: 'project' | 'user'): AgentMemoryCoverage {
  const namespace = scope === 'user' ? 'memory:user' : `memory:project:p${projectId}`;
  const state = db.prepare('SELECT active_generation_id, delta_items FROM semantic_namespace_generations WHERE namespace=?')
    .get(namespace) as { active_generation_id: number | null; delta_items: number } | undefined;
  const generationId = state?.active_generation_id ?? null;
  const stock = scope === 'user' ? "m.scope='user' AND m.project_id=0" : "m.scope IN ('project','local') AND m.project_id=?";
  const rows = db.prepare(`
    SELECT COUNT(*) AS live,
      COALESCE(SUM(chunks>0 AND complete=1),0) AS "indexed",
      COALESCE(SUM(failed_chunks>0),0) AS failed,
      COALESCE(SUM(chunks=0),0) AS missing
    FROM (
      SELECT m.id,COUNT(i.item_key) AS chunks,
        MIN(CASE WHEN i.status='indexed' AND i.vector_id IS NOT NULL THEN 1 ELSE 0 END) AS complete,
        SUM(CASE WHEN i.status='failed' THEN 1 ELSE 0 END) AS failed_chunks
      FROM agent_memory m LEFT JOIN semantic_items i
        ON i.namespace=? AND i.generation_id=? AND i.item_key='agent_memory:'||m.id
      WHERE ${stock} AND m.archived_at IS NULL GROUP BY m.id
    )
  `).get(namespace, generationId, ...(scope === 'project' ? [projectId] : [])) as {
    live: number; indexed: number; failed: number; missing: number;
  };
  return { namespace, generationId, ...rows,
    pending: Math.max(0, rows.live - rows.indexed - rows.failed - rows.missing),
    queuedMutations: state?.delta_items ?? 0 };
}
