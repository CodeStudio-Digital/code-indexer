import type { DB } from './types.js';

/**
 * Agent Memory consolidation ("dream") — a conservative, deterministic pruning
 * pass run by the idle memory-sweeper (WS8). NO LLM: it only collapses EXACT
 * content duplicates within a (scope, project) — a safety net on top of the
 * write-time fuzzy dedup (cross-session writes and migrated snapshots can still
 * produce identical rows). Stale handling stays in the retriever (a recency/
 * staleness discount), so this pass never archives something merely old.
 *
 * Logical-immutable: duplicates are ARCHIVED (soft delete), keeping the winner
 * (highest importance, then earliest created_at — preserve provenance) and
 * linking `superseded_by_id`. Archived rows are excluded from every read path,
 * and their vectors are harmless (the search re-checks `archived_at` on lookup),
 * so vector cleanup is left to forget/replace which own the service handle.
 */

export interface ConsolidationResult {
  scanned: number;
  archived: number;
}

/** Normalize content for exact-duplicate grouping (case/whitespace-insensitive). */
function normalizeContent(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Deterministic decay of cold LOW-VALUE rows (sweeper hygiene, no LLM):
 * archive `note`-type memories that were never accessed, sit under the
 * note-tier importance bar, and are older than `maxAgeDays`. Reversible
 * (reason `decayed:cold-note`, restorable from the UI). Preferences,
 * conventions, gotchas etc. are NEVER touched — only `note`.
 */
export function decayColdNotes(
  db: DB,
  scope: 'project' | 'user' | 'local',
  projectId: number,
  opts: { maxAgeDays?: number; importanceBelow?: number } = {},
): number {
  const maxAgeDays = Math.max(7, opts.maxAgeDays ?? 60);
  const importanceBelow = opts.importanceBelow ?? 0.4;
  return db
    .prepare(
      `UPDATE agent_memory
          SET archived_at = datetime('now'), archived_reason = 'decayed:cold-note',
              updated_at = datetime('now')
        WHERE scope = ? AND project_id = ? AND archived_at IS NULL
          AND type = 'note'
          AND access_count = 0
          AND importance < ?
          AND created_at < datetime('now', '-' || ? || ' days')`,
    )
    .run(scope, projectId, importanceBelow, maxAgeDays).changes;
}

export function consolidateProject(
  db: DB,
  scope: 'project' | 'user' | 'local',
  projectId: number,
  cap = 500,
): ConsolidationResult {
  const rows = db
    .prepare(
      `SELECT id, content, importance, created_at
         FROM agent_memory
        WHERE scope = ? AND project_id = ? AND archived_at IS NULL
        ORDER BY id LIMIT ?`,
    )
    .all(scope, projectId, cap) as Array<{
    id: number;
    content: string;
    importance: number;
    created_at: string;
  }>;

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = normalizeContent(r.content);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const archiveStmt = db.prepare(
    `UPDATE agent_memory
        SET archived_at = datetime('now'), archived_reason = 'consolidated:duplicate',
            superseded_by_id = ?, updated_at = datetime('now')
      WHERE id = ? AND archived_at IS NULL`,
  );

  let archived = 0;
  const tx = db.transaction(() => {
    for (const grp of groups.values()) {
      if (grp.length < 2) continue;
      // Winner: highest importance, then earliest created_at (oldest provenance).
      grp.sort((a, b) => b.importance - a.importance || (a.created_at < b.created_at ? -1 : 1));
      const keep = grp[0]!;
      for (const dup of grp.slice(1)) {
        archiveStmt.run(keep.id, dup.id);
        archived++;
      }
    }
  });
  tx();

  return { scanned: rows.length, archived };
}
