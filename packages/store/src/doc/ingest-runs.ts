import type { Database as DB } from 'better-sqlite3';
import type { DocIngestRun, DocIngestRunState, DocSourceItem } from './types.js';

export interface RunCountersPatch {
  state?: DocIngestRunState;
  phase?: string;
  total_items?: number;
  processed_items?: number;
  changed_items?: number;
  unchanged_items?: number;
  skipped_items?: number;
  errored_items?: number;
  chunks_persisted?: number;
  embeddings_completed?: number;
  enrichments_completed?: number;
  performance_profile?: string;
  worker_count?: number;
  error_message?: string | null;
  completed?: boolean;
}

function mapRun(row: Record<string, unknown>): DocIngestRun {
  return {
    ...(row as unknown as Omit<DocIngestRun, 'cancel_requested' | 'pause_requested'>),
    cancel_requested: Number(row.cancel_requested ?? 0) !== 0,
    pause_requested: Number(row.pause_requested ?? 0) !== 0,
  };
}

function mapItem(row: Record<string, unknown>): DocSourceItem {
  return row as unknown as DocSourceItem;
}

export function createRun(
  db: DB,
  sourceId: number,
  options: unknown,
  performanceProfile = 'balanced',
  workerCount = 1,
): DocIngestRun {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE doc_ingest_runs SET state='failed', error_message=COALESCE(error_message,'superseded'),
              completed_at=datetime('now'), heartbeat_at=datetime('now')
        WHERE source_id=? AND state='running'`,
    ).run(sourceId);
    const result = db.prepare(
      `INSERT INTO doc_ingest_runs(source_id, options_json, performance_profile, worker_count)
       VALUES (?, ?, ?, ?)`,
    ).run(sourceId, JSON.stringify(options ?? {}), performanceProfile, workerCount);
    db.prepare(`UPDATE doc_sources SET last_ingest_run_id=? WHERE id=?`)
      .run(result.lastInsertRowid, sourceId);
    return result.lastInsertRowid as number;
  });
  return getRun(db, tx())!;
}

export function resumeRun(db: DB, id: number): DocIngestRun | null {
  db.prepare(
    `UPDATE doc_ingest_runs SET state='running', phase='fetching', pause_requested=0,
       cancel_requested=0, completed_at=NULL, error_message=NULL, heartbeat_at=datetime('now')
     WHERE id=? AND state IN ('paused','paused_limit')`,
  ).run(id);
  return getRun(db, id);
}

export function getRun(db: DB, id: number): DocIngestRun | null {
  const row = db.prepare(`SELECT * FROM doc_ingest_runs WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export function getActiveRun(db: DB, sourceId: number): DocIngestRun | null {
  const row = db.prepare(
    `SELECT * FROM doc_ingest_runs WHERE source_id=? AND state='running' ORDER BY id DESC LIMIT 1`,
  ).get(sourceId) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export function listRuns(db: DB, sourceId: number, limit = 20): DocIngestRun[] {
  return (db.prepare(
    `SELECT * FROM doc_ingest_runs WHERE source_id=? ORDER BY id DESC LIMIT ?`,
  ).all(sourceId, Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>).map(mapRun);
}

export function updateRun(db: DB, id: number, patch: RunCountersPatch): void {
  const fields: string[] = [`heartbeat_at=datetime('now')`];
  const params: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'completed') continue;
    fields.push(`${key}=@${key}`);
    params[key] = value;
  }
  if (patch.completed) fields.push(`completed_at=datetime('now')`);
  db.prepare(`UPDATE doc_ingest_runs SET ${fields.join(',')} WHERE id=@id`).run(params);
}

export function requestCancel(db: DB, sourceId: number): boolean {
  const result = db.prepare(
    `UPDATE doc_ingest_runs SET cancel_requested=1, heartbeat_at=datetime('now')
      WHERE source_id=? AND state='running'`,
  ).run(sourceId);
  return result.changes > 0;
}

export function requestPause(db: DB, sourceId: number): boolean {
  const result = db.prepare(
    `UPDATE doc_ingest_runs SET pause_requested=1, heartbeat_at=datetime('now')
      WHERE source_id=? AND state='running'`,
  ).run(sourceId);
  return result.changes > 0;
}

export function isPauseRequested(db: DB, runId: number): boolean {
  const row = db.prepare(`SELECT pause_requested FROM doc_ingest_runs WHERE id=?`).get(runId) as
    | { pause_requested: number }
    | undefined;
  return Number(row?.pause_requested ?? 0) !== 0;
}

export function updatePerformance(
  db: DB,
  sourceId: number,
  profile: string,
  workerCount: number,
): boolean {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE doc_sources SET folder_performance_profile=?, folder_worker_count=?, updated_at=datetime('now')
       WHERE id=? AND type='folder'`,
    ).run(profile, workerCount, sourceId);
    return db.prepare(
      `UPDATE doc_ingest_runs SET performance_profile=?, worker_count=?, heartbeat_at=datetime('now')
       WHERE source_id=? AND state IN ('running','paused','paused_limit')`,
    ).run(profile, workerCount, sourceId).changes > 0;
  });
  return tx();
}

export function isCancelRequested(db: DB, runId: number): boolean {
  const row = db.prepare(`SELECT cancel_requested FROM doc_ingest_runs WHERE id=?`).get(runId) as
    | { cancel_requested: number }
    | undefined;
  return Number(row?.cancel_requested ?? 0) !== 0;
}

export function getItem(db: DB, sourceId: number, itemKey: string): DocSourceItem | null {
  const row = db.prepare(
    `SELECT * FROM doc_source_items WHERE source_id=? AND item_key=?`,
  ).get(sourceId, itemKey) as Record<string, unknown> | undefined;
  return row ? mapItem(row) : null;
}

export function upsertItem(
  db: DB,
  input: {
    source_id: number;
    item_key: string;
    source_uri?: string | null;
    size_bytes?: number | null;
    mtime_ms?: number | null;
    content_hash?: string | null;
    status: string;
    last_seen_run_id: number;
    chunk_count?: number;
    error_message?: string | null;
  },
): DocSourceItem {
  db.prepare(
    `INSERT INTO doc_source_items(
       source_id,item_key,source_uri,size_bytes,mtime_ms,content_hash,status,
       last_seen_run_id,chunk_count,error_message
     ) VALUES (
       @source_id,@item_key,@source_uri,@size_bytes,@mtime_ms,@content_hash,@status,
       @last_seen_run_id,@chunk_count,@error_message
     ) ON CONFLICT(source_id,item_key) DO UPDATE SET
       source_uri=excluded.source_uri, size_bytes=excluded.size_bytes,
       mtime_ms=excluded.mtime_ms, content_hash=excluded.content_hash,
       status=excluded.status, last_seen_run_id=excluded.last_seen_run_id,
       chunk_count=excluded.chunk_count, error_message=excluded.error_message,
       updated_at=datetime('now')`,
  ).run({
    source_uri: null,
    size_bytes: null,
    mtime_ms: null,
    content_hash: null,
    chunk_count: 0,
    error_message: null,
    ...input,
  });
  return getItem(db, input.source_id, input.item_key)!;
}

export function upsertItems(
  db: DB,
  inputs: ReadonlyArray<Parameters<typeof upsertItem>[1]>,
): void {
  if (inputs.length === 0) return;
  const tx = db.transaction(() => {
    for (const input of inputs) upsertItem(db, input);
  });
  tx();
}

export function listItemsNotSeen(db: DB, sourceId: number, runId: number): DocSourceItem[] {
  return (db.prepare(
    `SELECT * FROM doc_source_items WHERE source_id=? AND (last_seen_run_id IS NULL OR last_seen_run_id<>?)`,
  ).all(sourceId, runId) as Array<Record<string, unknown>>).map(mapItem);
}

export function deleteItems(db: DB, ids: readonly number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM doc_source_items WHERE id IN (${placeholders})`).run(...ids);
}
