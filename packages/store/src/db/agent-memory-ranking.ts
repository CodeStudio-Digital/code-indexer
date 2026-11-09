import { normalizeScopeProject } from './agent-memory-values.js';
import type { AgentMemoryIndexEntry } from './agent-memory-types.js';
import type { AgentMemoryScope, AgentMemoryType } from '@mcp/shared/types.js';
import type { DB } from './types.js';
/** Type weight for the turn-1 index ranking — the memory kinds that make the
 *  agent adhere to user preferences / project style outrank loose notes when
 *  competing for the ~1200-char index budget. (Mirrors the retriever's
 *  CATEGORY_WEIGHT in services/memory/scoring.ts — kept local: store cannot
 *  import services.) */
export const INDEX_TYPE_WEIGHT: Record<string, number> = {
  preference: 1.0, convention: 0.9, gotcha: 0.8, decision: 0.75,
  procedure: 0.7, architecture: 0.55, pattern: 0.5, external_pointer: 0.4, note: 0.25,
};

/** Explicit/user-authored memory is durable intent. Automatic session
 * distillation is useful evidence, but it must not outrank a slightly older
 * canonical decision merely because it was generated recently. */
export const INDEX_SOURCE_WEIGHT: Record<string, number> = {
  user: 1.1,
  manual: 1.1,
  agent: 1,
  'migrated-snapshot': 0.85,
  distill: 0.65,
  session: 0.65,
};

export function memoryTitleTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2),
  );
}

export function nearDuplicateTitle(a: string, b: string): boolean {
  const left = memoryTitleTokens(a);
  const right = memoryTitleTokens(b);
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  if (shared < 2) return false;
  const union = left.size + right.size - shared;
  return union > 0 && shared / union >= 0.5;
}

/**
 * Logical-frontmatter index for `recall_memory(mode:'list')` and the turn-1
 * memory index. Ranked by importance × 30-day recency decay × type weight.
 * Does NOT mark access (listing a title is not using the memory).
 */
export function listMemoryIndex(
  db: DB,
  scope: AgentMemoryScope,
  projectId: number,
  limit = 12,
  type?: AgentMemoryType,
): AgentMemoryIndexEntry[] {
  const pid = normalizeScopeProject(scope, projectId);
  const typeClause = type ? 'AND type = ?' : '';
  const params: unknown[] = [scope, pid];
  if (type) params.push(type);
  const now = Date.now();
  params.push(now / 86_400_000 + 2_440_587.5);
  // Apply the same score BEFORE the candidate cap. Importance-only prefiltering
  // made a fresh preference invisible behind 100 ancient, high-importance rows.
  const typeWeights = Object.entries(INDEX_TYPE_WEIGHT).map(([key, value]) => `WHEN '${key}' THEN ${value}`).join(' ');
  const sourceWeights = Object.entries(INDEX_SOURCE_WEIGHT).map(([key, value]) => `WHEN '${key}' THEN ${value}`).join(' ');
  const rows = db
    .prepare(
      `SELECT id, name, description, type, source, scope, importance, created_at, last_accessed_at,
              substr(content, 1, 200) AS excerpt
       FROM agent_memory
       WHERE scope = ? AND project_id = ? AND archived_at IS NULL ${typeClause}
       ORDER BY COALESCE(importance,0.5)
         * pow(0.5, MAX(0,COALESCE(?-julianday(COALESCE(last_accessed_at,created_at)),30))/30)
         * (0.5 + 0.5 * CASE type ${typeWeights} ELSE 0.5 END)
         * CASE source ${sourceWeights} ELSE 0.8 END DESC, id DESC
       LIMIT 100`,
    )
    .all(...params) as Array<{
    id: number; name: string; description: string; type: string; source: string; scope: string;
    importance: number; created_at: string; last_accessed_at: string | null; excerpt: string | null;
  }>;
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
  const scored = rows.map((r) => {
    const ts = Date.parse(`${(r.last_accessed_at ?? r.created_at).replace(' ', 'T')}Z`);
    const age = Number.isNaN(ts) ? HALF_LIFE_MS : Math.max(0, now - ts);
    const typeBoost = 0.5 + 0.5 * (INDEX_TYPE_WEIGHT[r.type] ?? 0.5);
    const sourceBoost = INDEX_SOURCE_WEIGHT[r.source] ?? 0.8;
    return {
      r,
      score: (r.importance ?? 0.5) * Math.pow(0.5, age / HALF_LIFE_MS) * typeBoost * sourceBoost,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  const diverse: typeof scored = [];
  for (const candidate of scored) {
    // Explicit facts can share title words while describing different decisions.
    // Only automatic distillation is eligible for lossy title diversification.
    if (diverse.some(({ r }) => (['session', 'distill'].includes(r.source) || ['session', 'distill'].includes(candidate.r.source))
      && nearDuplicateTitle(r.name, candidate.r.name))) continue;
    diverse.push(candidate);
    if (diverse.length >= Math.max(1, limit)) break;
  }
  return diverse.map(({ r }) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    type: r.type,
    source: r.source,
    scope: r.scope,
    importance: r.importance ?? 0.5,
    created_at: r.created_at,
    last_accessed_at: r.last_accessed_at,
    excerpt: r.excerpt ?? undefined,
  }));
}
