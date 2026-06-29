import type {
  AgentMemoryRow,
  AgentMemoryScope,
  AgentMemoryType,
} from '@mcp/shared/types.js';
import type { DB } from './types.js';
import { buildFtsMatch } from './fts-query.js';

/**
 * Dedicated Agent Memory store (migration 181) — durable single-fact memory the
 * agent writes for future sessions, SEPARATE from snapshots.
 *
 * Logical immutability: rows are never edited in place as the source of truth.
 * `replace` archives the old live row and creates a fresh one in ONE
 * transaction (archive + create + supersede link). The unique partial index
 * `(scope, project_id, name) WHERE archived_at IS NULL` guarantees one live row
 * per identity while allowing archive + recreate-same-name.
 */

export interface CreateAgentMemoryData {
  scope?: AgentMemoryScope;
  projectId?: number;
  /** kebab-case slug; callers normally pass a title and let {@link slugify} run. */
  name: string;
  description?: string;
  type?: AgentMemoryType;
  content: string;
  source?: string;
  sourceSnapshotId?: number | null;
  importance?: number;
  referencedFiles?: string[];
  /** Sync intent; ignored (forced 0) for local scope. */
  sync?: boolean;
}

export interface AgentMemoryIndexEntry {
  id: number;
  name: string;
  description: string;
  type: string;
  scope: string;
  importance: number;
  created_at: string;
  last_accessed_at: string | null;
  excerpt?: string;
}

export interface AgentMemoryEvent {
  eventType: string;
  scope?: string | null;
  projectId?: number | null;
  memoryId?: number | null;
  sessionId?: number | null;
  kept?: number | null;
  dropped?: number | null;
  queryHash?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Normalize a free-form title into a stable kebab-case slug (3-6 words). */
export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const words = base.split('-').filter(Boolean).slice(0, 6);
  return words.join('-') || 'memory';
}

/** Resolve a non-colliding live slug: name, name-2, name-3, … */
function resolveLiveSlug(
  db: DB,
  scope: AgentMemoryScope,
  projectId: number,
  desired: string,
): string {
  const exists = db.prepare(
    `SELECT 1 FROM agent_memory WHERE scope = ? AND project_id = ? AND name = ? AND archived_at IS NULL`,
  );
  if (!exists.get(scope, projectId, desired)) return desired;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired}-${i}`;
    if (!exists.get(scope, projectId, candidate)) return candidate;
  }
  return `${desired}-${Date.now()}`;
}

function normalizeScopeProject(scope: AgentMemoryScope, projectId: number): number {
  // user-scope memory always lives on the reserved project 0 (mirrors snapshots
  // user-memory). local/project keep their real project id.
  return scope === 'user' ? 0 : projectId;
}

/** A referenced file captured WITH the content hash at memory-creation time, so
 *  the retriever can flag staleness (file changed or vanished since). */
interface ReferencedFileSnapshot {
  path: string;
  /** content_hash at creation; null when the path wasn't in the file index. */
  hash: string | null;
}

/** Resolve current file hashes for the referenced paths (best-effort). */
function captureReferencedFiles(
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

export function create(db: DB, data: CreateAgentMemoryData): AgentMemoryRow {
  const scope: AgentMemoryScope = data.scope ?? 'project';
  const projectId = normalizeScopeProject(scope, data.projectId ?? 0);
  const desired = slugify(data.name);
  const name = resolveLiveSlug(db, scope, projectId, desired);
  const sync = scope === 'local' ? 0 : data.sync === false ? 0 : 1;
  const referenced =
    data.referencedFiles && data.referencedFiles.length > 0
      ? JSON.stringify(captureReferencedFiles(db, projectId, data.referencedFiles))
      : null;
  const result = db
    .prepare(
      `INSERT INTO agent_memory
         (scope, project_id, name, description, type, content, source,
          source_snapshot_id, importance, referenced_files, sync)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scope,
      projectId,
      name,
      data.description ?? '',
      data.type ?? 'note',
      data.content,
      data.source ?? 'agent',
      data.sourceSnapshotId ?? null,
      clamp01(data.importance ?? 0.5),
      referenced,
      sync,
    );
  return db
    .prepare('SELECT * FROM agent_memory WHERE id = ?')
    .get(result.lastInsertRowid) as AgentMemoryRow;
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
  const rowStmt = db.prepare('SELECT project_id, referenced_files FROM agent_memory WHERE id = ?');
  const fileStmt = db.prepare('SELECT content_hash FROM files WHERE project_id = ? AND path = ?');
  for (const id of ids) {
    const row = rowStmt.get(id) as
      | { project_id: number; referenced_files: string | null }
      | undefined;
    if (!row?.referenced_files) {
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
    const stale: string[] = [];
    for (const ref of withBaseline) {
      let current: string | null = null;
      try {
        const f = fileStmt.get(row.project_id, ref.path) as { content_hash?: string } | undefined;
        current = f?.content_hash ?? null;
      } catch {
        continue;
      }
      if (current === null || current !== ref.hash) stale.push(ref.path);
    }
    map.set(id, { stale, total: withBaseline.length });
  }
  return map;
}

/** Cheap metadata-only importance bump (corroboration) — NOT a content change,
 *  so it stays off the logical-immutable archive+create path. */
export function setImportance(db: DB, id: number, importance: number): void {
  db.prepare(`UPDATE agent_memory SET importance = ?, updated_at = datetime('now') WHERE id = ?`).run(
    clamp01(importance),
    id,
  );
}

/** Logically archive a live row (soft delete). Vectors are cleaned by the caller. */
export function archive(db: DB, id: number, reason = 'forgotten'): void {
  db.prepare(
    `UPDATE agent_memory SET archived_at = datetime('now'), archived_reason = ?,
       updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
  ).run(reason, id);
}

/**
 * Supersede: archive the old row and create a fresh one in ONE transaction,
 * linking `superseded_by_id`. Preserves the ORIGINAL `created_at` on the new row
 * so consolidation keeps the earliest provenance.
 */
export function replace(
  db: DB,
  oldId: number,
  data: CreateAgentMemoryData,
): AgentMemoryRow {
  const tx = db.transaction((): AgentMemoryRow => {
    const old = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(oldId) as
      | AgentMemoryRow
      | undefined;
    if (old && old.archived_at === null) {
      // Archive FIRST so the partial unique index releases (scope, project, name)
      // for the fresh replacement inside the same transaction.
      db.prepare(
        `UPDATE agent_memory SET archived_at = datetime('now'),
           archived_reason = ?, updated_at = datetime('now')
         WHERE id = ? AND archived_at IS NULL`,
      ).run('superseded:pending', oldId);
    }
    const fresh = create(db, data);
    if (old) {
      // carry the earliest created_at forward
      db.prepare('UPDATE agent_memory SET created_at = ? WHERE id = ?').run(
        old.created_at,
        fresh.id,
      );
      db.prepare(
        `UPDATE agent_memory SET archived_reason = ?, superseded_by_id = ?,
           updated_at = datetime('now') WHERE id = ?`,
      ).run(`superseded:${fresh.id}`, fresh.id, oldId);
    }
    return db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(fresh.id) as AgentMemoryRow;
  });
  return tx();
}

export function getById(db: DB, id: number): AgentMemoryRow | undefined {
  return db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(id) as
    | AgentMemoryRow
    | undefined;
}

export function getByName(
  db: DB,
  scope: AgentMemoryScope,
  projectId: number,
  name: string,
): AgentMemoryRow | undefined {
  const pid = normalizeScopeProject(scope, projectId);
  return db
    .prepare(
      `SELECT * FROM agent_memory WHERE scope = ? AND project_id = ? AND name = ? AND archived_at IS NULL`,
    )
    .get(scope, pid, slugify(name)) as AgentMemoryRow | undefined;
}

/** Bump usage signal when a memory is retrieved. Best-effort. */
export function bumpAccess(db: DB, ids: number[]): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(
    `UPDATE agent_memory SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?`,
  );
  const tx = db.transaction((list: number[]) => {
    for (const id of list) stmt.run(id);
  });
  tx(ids);
}

export function updateEmbedding(db: DB, id: number, hash: string, vectorId: string | null): void {
  db.prepare('UPDATE agent_memory SET embedding_hash = ?, vector_id = ? WHERE id = ?').run(
    hash,
    vectorId,
    id,
  );
}

export function listMissingEmbedding(db: DB, projectId?: number): AgentMemoryRow[] {
  if (projectId === undefined) {
    return db
      .prepare('SELECT * FROM agent_memory WHERE embedding_hash IS NULL AND archived_at IS NULL ORDER BY id')
      .all() as AgentMemoryRow[];
  }
  return db
    .prepare('SELECT * FROM agent_memory WHERE project_id = ? AND embedding_hash IS NULL AND archived_at IS NULL ORDER BY id')
    .all(projectId) as AgentMemoryRow[];
}

/**
 * Logical-frontmatter index for `recall_memory(mode:'list')` and the turn-1
 * memory index. Ranked by importance × 30-day recency decay. Does NOT mark
 * access (listing a title is not using the memory).
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
  const rows = db
    .prepare(
      `SELECT id, name, description, type, scope, importance, created_at, last_accessed_at,
              substr(content, 1, 200) AS excerpt
       FROM agent_memory
       WHERE scope = ? AND project_id = ? AND archived_at IS NULL ${typeClause}
       ORDER BY importance DESC LIMIT 100`,
    )
    .all(...params) as Array<{
    id: number; name: string; description: string; type: string; scope: string;
    importance: number; created_at: string; last_accessed_at: string | null; excerpt: string | null;
  }>;
  const now = Date.now();
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
  const scored = rows.map((r) => {
    const ts = Date.parse(`${(r.last_accessed_at ?? r.created_at).replace(' ', 'T')}Z`);
    const age = Number.isNaN(ts) ? HALF_LIFE_MS : Math.max(0, now - ts);
    return { r, score: (r.importance ?? 0.5) * Math.pow(0.5, age / HALF_LIFE_MS) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map(({ r }) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    type: r.type,
    scope: r.scope,
    importance: r.importance ?? 0.5,
    created_at: r.created_at,
    last_accessed_at: r.last_accessed_at,
    excerpt: r.excerpt ?? undefined,
  }));
}

/** FTS search within a scope/project. Falls back to LIKE when the MATCH fails. */
export function searchFts(
  db: DB,
  scope: AgentMemoryScope,
  projectId: number,
  query: string,
  limit = 15,
): AgentMemoryRow[] {
  const pid = normalizeScopeProject(scope, projectId);
  const ftsQuery = buildFtsMatch(query, 'OR');
  if (ftsQuery) {
    try {
      return db
        .prepare(
          `SELECT m.* FROM agent_memory_fts fts
             JOIN agent_memory m ON m.id = fts.rowid
            WHERE fts.agent_memory_fts MATCH ? AND m.scope = ? AND m.project_id = ? AND m.archived_at IS NULL
            ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, scope, pid, limit) as AgentMemoryRow[];
    } catch {
      /* fall through to LIKE */
    }
  }
  const pattern = `%${query}%`;
  return db
    .prepare(
      `SELECT * FROM agent_memory
        WHERE scope = ? AND project_id = ? AND archived_at IS NULL
          AND (name LIKE ? OR description LIKE ? OR content LIKE ?)
        ORDER BY importance DESC LIMIT ?`,
    )
    .all(scope, pid, pattern, pattern, pattern, limit) as AgentMemoryRow[];
}

export function count(db: DB, scope: AgentMemoryScope, projectId: number): number {
  const pid = normalizeScopeProject(scope, projectId);
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM agent_memory WHERE scope = ? AND project_id = ? AND archived_at IS NULL')
    .get(scope, pid) as { c: number };
  return row.c;
}

export function findBySourceSnapshot(db: DB, snapshotId: number): AgentMemoryRow | undefined {
  return db
    .prepare('SELECT * FROM agent_memory WHERE source_snapshot_id = ? LIMIT 1')
    .get(snapshotId) as AgentMemoryRow | undefined;
}

/** Record a lightweight telemetry event. Best-effort — never throws. */
export function recordEvent(db: DB, e: AgentMemoryEvent): void {
  try {
    db.prepare(
      `INSERT INTO agent_memory_events
         (event_type, scope, project_id, memory_id, session_id, kept, dropped, query_hash, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.eventType,
      e.scope ?? null,
      e.projectId ?? null,
      e.memoryId ?? null,
      e.sessionId ?? null,
      e.kept ?? null,
      e.dropped ?? null,
      e.queryHash ?? null,
      e.meta ? JSON.stringify(e.meta) : null,
    );
  } catch {
    /* telemetry must never break a write */
  }
}

/** Retention: prune old telemetry events past a max age (days) and row cap. */
export function pruneEvents(db: DB, maxAgeDays = 30, maxRows = 50_000): number {
  let removed = 0;
  try {
    removed += db
      .prepare(`DELETE FROM agent_memory_events WHERE created_at < datetime('now', ?)`)
      .run(`-${Math.max(1, maxAgeDays)} days`).changes;
    const overflow = db
      .prepare('SELECT COUNT(*) AS c FROM agent_memory_events')
      .get() as { c: number };
    if (overflow.c > maxRows) {
      removed += db
        .prepare(
          `DELETE FROM agent_memory_events WHERE id IN (
             SELECT id FROM agent_memory_events ORDER BY id ASC LIMIT ?
           )`,
        )
        .run(overflow.c - maxRows).changes;
    }
  } catch {
    /* best-effort */
  }
  return removed;
}

export interface AgentMemoryStats {
  /** Live (non-archived) project-scope memories (optionally for one project). */
  liveProject: number;
  /** Live global user-scope memories. */
  liveUser: number;
  /** Telemetry event counts by type (remember/recall/forget/selector/…). */
  events: Record<string, number>;
}

/**
 * Aggregate health stats for the memory dashboard / a "prove it left dormancy"
 * check. Optionally scoped to one project (user-scope counts stay global).
 */
export function getStats(db: DB, projectId?: number): AgentMemoryStats {
  const liveProject = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_memory WHERE scope = 'project' AND archived_at IS NULL${
          projectId != null ? ' AND project_id = ?' : ''
        }`,
      )
      .get(...(projectId != null ? [projectId] : [])) as { c: number }
  ).c;
  const liveUser = (
    db.prepare(`SELECT COUNT(*) AS c FROM agent_memory WHERE scope = 'user' AND archived_at IS NULL`).get() as {
      c: number;
    }
  ).c;
  const evRows = db
    .prepare(
      `SELECT event_type, COUNT(*) AS c FROM agent_memory_events${
        projectId != null ? ' WHERE project_id = ?' : ''
      } GROUP BY event_type`,
    )
    .all(...(projectId != null ? [projectId] : [])) as Array<{ event_type: string; c: number }>;
  const events: Record<string, number> = {};
  for (const r of evRows) events[r.event_type] = r.c;
  return { liveProject, liveUser, events };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
