export { listMemoryIndex } from './agent-memory-ranking.js';
import { captureReferencedFiles } from './agent-memory-references.js';
import { validatePreservedMemoryReferences } from './preserved-memory-references.js';
export { getStaleReferencedFiles, getStaleBatch } from './agent-memory-references.js';
import { slugify, normalizeScopeProject, BATCH_IDS, clamp01 } from './agent-memory-values.js';
export { slugify } from './agent-memory-values.js';
import type { CreateAgentMemoryData, AgentMemoryIndexEntry, AgentMemoryEvent, AgentMemoryStats } from './agent-memory-types.js';
export type { CreateAgentMemoryData, AgentMemoryIndexEntry, AgentMemoryEvent, AgentMemoryStats } from './agent-memory-types.js';
import type { AgentMemoryRow, AgentMemoryScope } from '@mcp/shared/types.js';
import type { DB } from './types.js';
import { buildFtsMatch } from './fts-query.js';

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

export function create(db: DB, data: CreateAgentMemoryData, fileIndex: DB | null = db): AgentMemoryRow {
  const scope: AgentMemoryScope = data.scope ?? 'project';
  const projectId = normalizeScopeProject(scope, data.projectId ?? 0);
  const desired = slugify(data.name);
  const name = resolveLiveSlug(db, scope, projectId, desired);
  const sync = scope === 'local' ? 0 : data.sync === false ? 0 : 1;
  const referenced = data.referencedFileSnapshots !== undefined
    ? (scope === 'user' ? null : JSON.stringify(validatePreservedMemoryReferences(data.referencedFileSnapshots)))
    : data.referencedFiles && data.referencedFiles.length > 0
      ? JSON.stringify(captureReferencedFiles(fileIndex, projectId, data.referencedFiles))
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
 * Un-archive (the archive round-trip). Returns false when nothing was restored
 * — id unknown, already live, or a LIVE row with the same (scope, project,
 * name) exists (the partial unique index would reject the resurrection).
 * The caller re-embeds the restored row.
 */
export function restore(db: DB, id: number): boolean {
  const row = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(id) as
    | AgentMemoryRow
    | undefined;
  if (!row || row.archived_at === null) return false;
  const collision = db
    .prepare(
      `SELECT 1 FROM agent_memory WHERE scope = ? AND project_id = ? AND name = ? AND archived_at IS NULL`,
    )
    .get(row.scope, row.project_id, row.name);
  if (collision) return false;
  db.prepare(
    `UPDATE agent_memory SET archived_at = NULL, archived_reason = NULL,
       superseded_by_id = NULL, updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
  return true;
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
  fileIndex: DB | null = db,
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
    const fresh = create(db, data, fileIndex);
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

/**
 * Hydrate many memories in one statement per chunk.
 *
 * Callers previously looped `getById`, which on a hybrid search meant up to 60
 * (per-turn retrieve) or 144 (recall_memory) synchronous point queries — each
 * one blocking the Electron main thread, since this store shares the main
 * process connection.
 *
 * Returns ONLY the rows that exist, in an unspecified order. Callers that care
 * about ordering (vector-match rank feeds RRF scoring) must re-impose it.
 */
export function getByIds(db: DB, ids: readonly number[]): AgentMemoryRow[] {
  if (ids.length === 0) return [];
  const out: AgentMemoryRow[] = [];
  for (let i = 0; i < ids.length; i += BATCH_IDS) {
    const chunk = ids.slice(i, i + BATCH_IDS);
    const rows = db
      .prepare(`SELECT * FROM agent_memory WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as AgentMemoryRow[];
    out.push(...rows);
  }
  return out;
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

/** All live source rows for a local semantic namespace. The semantic_items
 * ledger, not embedding_hash/vector_id columns, decides index completion. */
export function listForSemanticIndex(
  db: DB,
  scope: AgentMemoryScope,
  projectId: number,
): AgentMemoryRow[] {
  const pid = normalizeScopeProject(scope, projectId);
  return db.prepare(
    `SELECT * FROM agent_memory
     WHERE scope = ? AND project_id = ? AND archived_at IS NULL
     ORDER BY id`,
  ).all(scope, pid) as AgentMemoryRow[];
}

/**
 * Full live rows for the curation surfaces (user-memory panel, AgentMemoryList)
 * — unlike `listMemoryIndex` this returns COMPLETE content, optionally with the
 * archived tail for restore. Ordered live-first, then importance.
 */
export function listLive(
  db: DB,
  scope: AgentMemoryScope,
  projectId: number,
  opts: { includeArchived?: boolean; limit?: number } = {},
): AgentMemoryRow[] {
  const pid = normalizeScopeProject(scope, projectId);
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const archivedClause = opts.includeArchived ? '' : 'AND archived_at IS NULL';
  return db
    .prepare(
      `SELECT * FROM agent_memory
        WHERE scope = ? AND project_id = ? ${archivedClause}
        ORDER BY (archived_at IS NULL) DESC, importance DESC, updated_at DESC
        LIMIT ?`,
    )
    .all(scope, pid, limit) as AgentMemoryRow[];
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
         (event_type, scope, project_id, memory_id, kept, dropped, query_hash, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.eventType,
      e.scope ?? null,
      e.projectId ?? null,
      e.memoryId ?? null,
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

/**
 * Aggregate health stats for the memory dashboard / a "prove it left dormancy"
 * check. Project stock includes project/local memories, matching curation;
 * user-scope counts stay global. Retrieval APIs keep their exact scope.
 */
export function getStats(db: DB, projectId?: number): AgentMemoryStats {
  const liveProject = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_memory WHERE scope IN ('project', 'local') AND archived_at IS NULL${
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
  const recall = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kept > 0 THEN 1 ELSE 0 END), 0) AS hits,
              COALESCE(SUM(CASE WHEN kept = 0 THEN 1 ELSE 0 END), 0) AS empty
         FROM agent_memory_events WHERE event_type = 'recall'${
           projectId != null ? ' AND project_id = ?' : ''
         }`,
    )
    .get(...(projectId != null ? [projectId] : [])) as { hits: number; empty: number };
  return { liveProject, liveUser, events, recallHits: recall.hits, recallEmpty: recall.empty };
}
