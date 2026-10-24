import { BATCH_IDS } from './agent-memory-values.js';
import type { ReferencedFileSnapshot } from './agent-memory-types.js';
import type { DB } from './types.js';
/** False-stale guard: a project with NO rows in `files` (never indexed, or a
 *  trimmed per-project DB) cannot be judged — every lookup would miss and mark
 *  EVERYTHING stale (unfair 0.5 score discount + risky GC input). */
export function projectHasFileIndex(db: DB, projectId: number): boolean {
  try {
    return db.prepare('SELECT 1 FROM files WHERE project_id = ? LIMIT 1').get(projectId) != null;
  } catch {
    return false; // files table absent → not judgeable
  }
}

/** Resolve current file hashes for the referenced paths (best-effort). */
export function captureReferencedFiles(
  db: DB,
  projectId: number,
  paths: string[],
): ReferencedFileSnapshot[] {
  const stmt = db.prepare('SELECT content_hash FROM files WHERE project_id = ? AND path = ?');
  return paths.map((p) => {
    let hash: string | null = null;
    try {
      const row = stmt.get(projectId, p) as { content_hash?: string } | undefined;
      hash = row?.content_hash ?? null;
    } catch {
      /* files table absent on a trimmed per-project DB — store path only */
    }
    return { path: p, hash };
  });
}

/**
 * Return the referenced files that have CHANGED or VANISHED since the memory was
 * created (current content_hash differs from the captured one). Powers the
 * retriever's stale note. Empty when the memory has no referenced files or all
 * still match.
 */
export function getStaleReferencedFiles(db: DB, id: number): string[] {
  const row = db.prepare('SELECT project_id, referenced_files FROM agent_memory WHERE id = ?')
    .get(id) as { project_id: number; referenced_files: string | null } | undefined;
  if (!row?.referenced_files) return [];
  if (!projectHasFileIndex(db, row.project_id)) return [];
  let refs: ReferencedFileSnapshot[];
  try {
    const parsed = JSON.parse(row.referenced_files);
    if (!Array.isArray(parsed)) return [];
    // Tolerate the legacy plain-string[] shape (no baseline hash → never stale).
    refs = parsed.map((r) => (typeof r === 'string' ? { path: r, hash: null } : r));
  } catch {
    return [];
  }
  const stmt = db.prepare('SELECT content_hash FROM files WHERE project_id = ? AND path = ?');
  const stale: string[] = [];
  for (const ref of refs) {
    if (ref.hash == null) continue; // no baseline hash → cannot judge; skip
    let current: string | null = null;
    try {
      const f = stmt.get(row.project_id, ref.path) as { content_hash?: string } | undefined;
      current = f?.content_hash ?? null;
    } catch {
      continue;
    }
    if (current === null || current !== ref.hash) stale.push(ref.path);
  }
  return stale;
}

/**
 * Batched staleness for the retriever: id → {stale paths, total referenced}.
 * `total` counts only paths captured WITH a baseline hash (the only ones we can
 * judge); `stale` is the subset whose current content_hash differs or vanished.
 */
export function getStaleBatch(
  db: DB,
  ids: number[],
): Map<number, { stale: string[]; total: number }> {
  const map = new Map<number, { stale: string[]; total: number }>();
  if (ids.length === 0) return map;
  // Was 1 + N statements per memory (one row lookup, then one `files` lookup per
  // referenced path). On a recall that is hundreds of synchronous queries on the
  // Electron main thread. Now: one row batch, then one `files` batch per project.
  const indexedCache = new Map<number, boolean>();
  const indexed = (pid: number): boolean => {
    let v = indexedCache.get(pid);
    if (v === undefined) { v = projectHasFileIndex(db, pid); indexedCache.set(pid, v); }
    return v;
  };

  const rows = new Map<number, { project_id: number; referenced_files: string | null }>();
  for (let i = 0; i < ids.length; i += BATCH_IDS) {
    const chunk = ids.slice(i, i + BATCH_IDS);
    const batch = db
      .prepare(
        `SELECT id, project_id, referenced_files
           FROM agent_memory
          WHERE id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as Array<{ id: number; project_id: number; referenced_files: string | null }>;
    for (const r of batch) rows.set(r.id, { project_id: r.project_id, referenced_files: r.referenced_files });
  }

  // Pass 1 — parse, and collect the paths each project needs looked up.
  const pending = new Map<number, { projectId: number; refs: ReferencedFileSnapshot[] }>();
  const wantedByProject = new Map<number, Set<string>>();
  for (const id of ids) {
    const row = rows.get(id);
    if (!row?.referenced_files || !indexed(row.project_id)) {
      map.set(id, { stale: [], total: 0 });
      continue;
    }
    let refs: ReferencedFileSnapshot[];
    try {
      const parsed = JSON.parse(row.referenced_files);
      if (!Array.isArray(parsed)) {
        map.set(id, { stale: [], total: 0 });
        continue;
      }
      refs = parsed.map((r) => (typeof r === 'string' ? { path: r, hash: null } : r));
    } catch {
      map.set(id, { stale: [], total: 0 });
      continue;
    }
    const withBaseline = refs.filter((r) => r.hash != null);
    pending.set(id, { projectId: row.project_id, refs: withBaseline });
    let wanted = wantedByProject.get(row.project_id);
    if (!wanted) { wanted = new Set(); wantedByProject.set(row.project_id, wanted); }
    for (const ref of withBaseline) wanted.add(ref.path);
  }

  // Pass 2 — one batched hash lookup per project.
  const hashesByProject = new Map<number, Map<string, string | null>>();
  for (const [projectId, wanted] of wantedByProject) {
    const found = new Map<string, string | null>();
    const paths = [...wanted];
    for (let i = 0; i < paths.length; i += BATCH_IDS) {
      const chunk = paths.slice(i, i + BATCH_IDS);
      try {
        const batch = db
          .prepare(
            `SELECT path, content_hash
               FROM files
              WHERE project_id = ? AND path IN (${chunk.map(() => '?').join(',')})`,
          )
          .all(projectId, ...chunk) as Array<{ path: string; content_hash?: string }>;
        for (const f of batch) found.set(f.path, f.content_hash ?? null);
      } catch {
        // Per-project table trouble: leave this chunk unknown. Matches the old
        // per-path `catch { continue }`, which skipped rather than marking stale.
        for (const p of chunk) found.set(p, undefined as unknown as string | null);
      }
    }
    hashesByProject.set(projectId, found);
  }

  // Pass 3 — compare.
  for (const [id, { projectId, refs }] of pending) {
    const hashes = hashesByProject.get(projectId);
    const stale: string[] = [];
    for (const ref of refs) {
      if (!hashes || !hashes.has(ref.path)) {
        // Not present in `files` at all → the path vanished from the index.
        stale.push(ref.path);
        continue;
      }
      const current = hashes.get(ref.path);
      if (current === undefined) continue; // Lookup failed; cannot judge.
      if (current === null || current !== ref.hash) stale.push(ref.path);
    }
    map.set(id, { stale, total: refs.length });
  }
  return map;
}
