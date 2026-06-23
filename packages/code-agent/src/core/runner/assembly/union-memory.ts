/**
 * Memory READ-union helpers for GLOBAL (multi-project) sessions.
 *
 * A global session runs over a SYNTHETIC union project (mig 155) whose own
 * memory is empty/ephemeral. So instead of reading one project's memory we read
 * EVERY real constituent and merge — labeling each entry with its project name
 * so the agent knows which project a learning came from. These are pure: the
 * caller does the per-project DB/port fetches, then hands the results here.
 *
 * Single-project (the common case) is the identity path: one input project,
 * NO label, NO re-rank, NO cap — byte-equivalent to the pre-union behaviour.
 */

/** A project whose memory is read into a session. */
export interface ReadProject {
  id: number;
  name: string;
}

/** Per-project fetch budget for the injected index when unioning N projects. */
export function perProjectIndexLimit(projectCount: number, total = 12): number {
  return projectCount <= 1 ? total : Math.max(4, Math.ceil(total / projectCount));
}

/**
 * Merge per-project memory-index entries (each already importance-sorted within
 * its project) into one list: label by project, globally re-rank by importance,
 * cap to `total`. Single project → returned as-is (no label, no cap).
 */
export function mergeMemoryIndex<T extends { title: string; importance: number }>(
  perProject: Array<{ name: string; entries: T[] }>,
  total = 12,
): T[] {
  if (perProject.length <= 1) return perProject[0]?.entries ?? [];
  const merged = perProject.flatMap((p) =>
    p.entries.map((e) => ({ ...e, title: `[${p.name}] ${e.title}` })),
  );
  merged.sort((a, b) => b.importance - a.importance);
  return merged.slice(0, total);
}

/**
 * Round-robin interleave per-project result lists so no single project
 * dominates, labeling each row with its project name. Optionally cap to
 * `limit`. Single project → returned as-is (no label, no cap).
 */
export function interleaveLabeled<T extends { title: string }>(
  perProject: Array<{ name: string; rows: T[] }>,
  limit?: number,
): T[] {
  if (perProject.length <= 1) return perProject[0]?.rows ?? [];
  const labeled = perProject.map((p) =>
    p.rows.map((r) => ({ ...r, title: `[${p.name}] ${r.title}` })),
  );
  const merged: T[] = [];
  const maxLen = Math.max(0, ...labeled.map((l) => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const l of labeled) if (l[i]) merged.push(l[i]);
  }
  return limit ? merged.slice(0, limit) : merged;
}
