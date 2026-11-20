import type { DB } from './types.js';
import { bumpContentRevision } from './structural-state.js';
import { columnFtsMatch } from './fts-query.js';

/** Mirror of the scanner's size cap — defense for watcher-path callers. */
export const MAX_CONTENT_BYTES = 200 * 1024;
/** Average line length above this reads as minified/data, not code. */
const MAX_AVG_LINE_LEN = 500;
/** Increment when the eligibility rules change so prior exclusions are reconsidered. */
const EXCLUSION_PREFIX = '1:';

/**
 * Whether raw content belongs in `file_contents_fts`. The scanner already
 * filters binaries/oversized files, but watcher-grade callers feed arbitrary
 * paths — re-check here so the index never bloats on minified bundles.
 */
export function isContentIndexable(content: string, sizeBytes?: number): boolean {
  const bytes = sizeBytes ?? Buffer.byteLength(content, 'utf-8');
  if (bytes === 0 || bytes > MAX_CONTENT_BYTES) return false;
  if (content.includes('\0')) return false;
  let offset = -1;
  for (let linesNeeded = Math.ceil(content.length / MAX_AVG_LINE_LEN); linesNeeded > 1; linesNeeded--) {
    offset = content.indexOf('\n', offset + 1);
    if (offset === -1) return false;
  }
  return true;
}

/**
 * Set-or-clear the content index entry for a file. Contentless FTS5 has no
 * UPDATE — delete + insert (contentless_delete=1 makes the delete legal).
 * When the content fails the indexability guard the stale entry is REMOVED
 * (a file that became minified must stop matching). Returns whether the
 * file is now content-indexed.
 */
export function upsertContent(db: DB, fileId: number, content: string, sizeBytes?: number, contentHash?: string): boolean {
  const bytes = sizeBytes ?? Buffer.byteLength(content, 'utf-8');
  const indexable = isContentIndexable(content, bytes);
  return db.transaction(() => {
    const deleted = db.prepare('DELETE FROM file_contents_fts WHERE rowid = ?').run(fileId).changes;
    if (!indexable) {
      if (contentHash !== undefined) recordExclusion(db, fileId, bytes, contentHash);
      if (deleted) bumpContentRevision(db, fileId);
      return false;
    }
    clearExclusion(db, fileId);
    db.prepare('INSERT INTO file_contents_fts(rowid, content) VALUES (?, ?)').run(fileId, content);
    bumpContentRevision(db, fileId);
    return true;
  })();
}

function recordExclusion(db: DB, fileId: number, size: number, hash: string): void {
  const exclusion = `${EXCLUSION_PREFIX}${size}:${hash}`;
  db.prepare(`UPDATE files AS f SET content_fts_exclusion = ?
    WHERE f.id = ? AND f.content_hash = ? AND f.size = ? AND f.content_fts_exclusion IS NOT ?
      AND NOT EXISTS (SELECT 1 FROM file_contents_fts c WHERE c.rowid = f.id)`)
    .run(exclusion, fileId, hash, size, exclusion);
}

function clearExclusion(db: DB, fileId: number): void {
  db.prepare('UPDATE files SET content_fts_exclusion = NULL WHERE id = ? AND content_fts_exclusion IS NOT NULL').run(fileId);
}

export function removeContent(db: DB, fileId: number): void {
  db.transaction(() => {
    clearExclusion(db, fileId);
    if (db.prepare('DELETE FROM file_contents_fts WHERE rowid = ?').run(fileId).changes) bumpContentRevision(db, fileId);
  })();
}

export interface ContentMatch {
  id: number;
  path: string;
  rank: number;
}

/**
 * MATCH over raw contents, scoped to one project. `match` must already be a
 * valid FTS5 query (callers sanitize). Phrase literals become word intersections
 * because the compact index has no positions; exact matching needs source
 * verification. A malformed expression throws
 * SQLITE_ERROR like every other FTS path here. Slim rows — callers rehydrate
 * full file records by id when they need more than the path.
 */
export function searchContent(db: DB, projectId: number, match: string, limit: number = 50): ContentMatch[] {
  return db.prepare(`
    SELECT f.id as id, f.path as path, c.rank as rank
    FROM file_contents_fts c
    JOIN files f ON f.id = c.rowid
    WHERE c.file_contents_fts MATCH ? AND f.project_id = ?
    ORDER BY c.rank
    LIMIT ?
  `).all(columnFtsMatch(match), projectId, limit) as ContentMatch[];
}

/**
 * Files lacking a content-index entry — feeds the coverage sweep (first
 * upgrade backfill + post-corruption self-heal + failed-write repair).
 */
export function missingContentFiles(db: DB, projectId: number, limit: number = 500): Array<{ id: number; path: string }> {
  return db.prepare(`
    SELECT f.id as id, f.path as path FROM files f
    WHERE f.project_id = ?
      AND NOT EXISTS (SELECT 1 FROM file_contents_fts c WHERE c.rowid = f.id)
    LIMIT ?
  `).all(projectId, limit) as Array<{ id: number; path: string }>;
}

export interface ContentBackfillCandidate {
  id: number;
  path: string;
  size: number;
  content_hash: string;
}

export function contentBackfillCandidates(db: DB, projectId: number, afterId: number, limit: number): ContentBackfillCandidate[] {
  return db.prepare(`SELECT f.id, f.path, f.size, f.content_hash FROM files f
    WHERE f.project_id = ? AND f.id > ?
      AND f.content_fts_exclusion IS NOT (? || f.size || ':' || f.content_hash)
      AND NOT EXISTS (SELECT 1 FROM file_contents_fts c WHERE c.rowid = f.id)
    ORDER BY f.id LIMIT ?`).all(projectId, afterId, EXCLUSION_PREFIX, limit) as ContentBackfillCandidate[];
}

/** The snapshot was read outside SQLite. Recheck its identity within the writer transaction. */
export function backfillContent(db: DB, file: ContentBackfillCandidate, content: string): boolean {
  if (!isContentIndexable(content, file.size)) {
    recordExclusion(db, file.id, file.size, file.content_hash);
    return false;
  }
  return db.transaction(() => {
    const inserted = db.prepare(`INSERT INTO file_contents_fts(rowid, content)
      SELECT f.id, ? FROM files f
      WHERE f.id = ? AND f.path = ? AND f.content_hash = ? AND f.size = ?
        AND NOT EXISTS (SELECT 1 FROM file_contents_fts c WHERE c.rowid = f.id)`)
      .run(content, file.id, file.path, file.content_hash, file.size).changes;
    if (!inserted) return false;
    clearExclusion(db, file.id);
    bumpContentRevision(db, file.id);
    return true;
  })();
}

export function countContent(db: DB, projectId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM file_contents_fts c
    JOIN files f ON f.id = c.rowid
    WHERE f.project_id = ?
  `).get(projectId) as { cnt: number };
  return row.cnt;
}
