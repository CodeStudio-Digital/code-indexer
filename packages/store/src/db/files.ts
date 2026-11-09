import type { DBFile } from '@mcp/shared/types.js';
import type { DB } from './types.js';

/** Return only the best paths, without hydrating/transferring full DBFile rows.
 * SQLite does matching and a bounded top-K sort over the project/path index. */
export function searchPaths(db: DB, projectId: number, query: string, limit = 50, fuzzy = true): Array<{ path: string }> {
  const q = query.trim().replace(/\\/g, '/').slice(0, 128).toLowerCase();
  if (!q) return [];
  const take = Math.max(1, Math.min(300, Number.isFinite(limit) ? Math.floor(limit) : 50));
  const escape = (text: string) => text.replace(/[\\%_]/g, '\\$&');
  const pattern = `%${fuzzy ? [...q].map(escape).join('%') : escape(q)}%`;
  const candidates = new Set<string>();
  // Prefix uses a covering B-tree; substrings use trigram postings. The
  // expensive subsequence fallback examines a bounded candidate window.
  for (const row of db.prepare('SELECT path FROM files WHERE project_id=? AND path LIKE ? ESCAPE \'\\\' ORDER BY path LIMIT ?')
    .all(projectId, `${escape(q)}%`, take) as { path: string }[]) candidates.add(row.path);
  for (const row of db.prepare(`SELECT path FROM files WHERE project_id=?
    AND substr(path,length(rtrim(path,replace(path,'/','')))+1) LIKE ? ESCAPE '\\' LIMIT ?`)
    .all(projectId, `${escape(q)}%`, take) as { path: string }[]) candidates.add(row.path);
  if ([...q].length >= 3) {
    for (const row of db.prepare(`SELECT f.path FROM file_paths_fts p JOIN files f ON f.id=p.rowid
      WHERE file_paths_fts MATCH ? AND f.project_id=? LIMIT 3000`).all(`"${q.replace(/"/g, '""')}"`, projectId) as { path: string }[]) candidates.add(row.path);
  }
  if (fuzzy && candidates.size < take || q.length < 3) {
    const fallback = db.prepare(`
    WITH matches AS (
      SELECT path, instr(lower(path), ?) AS pos FROM
        (SELECT path FROM files WHERE project_id = ? ORDER BY path LIMIT 5000)
      WHERE path LIKE ? ESCAPE '\\'
    )
    SELECT path FROM matches ORDER BY
      CASE WHEN pos = 0 THEN 100000 + length(path)
        ELSE (pos - 1) * 2 + length(path)
          - CASE WHEN pos = 1 OR substr(path, pos - 1, 1) = '/' THEN 1000 ELSE 0 END
      END, path LIMIT ?
    `).all(q, projectId, pattern, take) as Array<{ path: string }>;
    for (const row of fallback) candidates.add(row.path);
  }
  const score = (path: string) => {
    const pos = path.toLowerCase().indexOf(q);
    return pos < 0 ? 100_000 + path.length : pos * 2 + path.length - (pos === 0 || path[pos - 1] === '/' ? 1000 : 0);
  };
  return [...candidates].sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, take).map(path => ({ path }));
}

/** Bounded path-only acquisition for live search; one extra row proves truncation. */
export function listPathsBounded(db: DB, projectId: number, language?: string, limit = 5000): { paths: string[]; truncated: boolean } {
  const take = Math.max(1, Math.min(10000, Number.isFinite(limit) ? Math.floor(limit) : 5000));
  const rows = (language
    ? db.prepare('SELECT path FROM files WHERE project_id=? AND language=? ORDER BY path LIMIT ?').all(projectId, language, take + 1)
    : db.prepare('SELECT path FROM files WHERE project_id=? ORDER BY path LIMIT ?').all(projectId, take + 1)) as { path: string }[];
  return { paths: rows.slice(0, take).map(r => r.path), truncated: rows.length > take };
}

export interface UpsertFileData {
  path: string;
  language: string;
  size: number;
  lineCount: number;
  contentHash: string;
  dependencies?: string[];
  internalDeps?: string[];
  externalDeps?: string[];
  isEntryPoint?: boolean;
  isTest?: boolean;
  isGenerated?: boolean;
  indexTier?: 'core' | 'support' | 'on_demand';
  mapperReason?: string;
  /**
   * fs.stat mtime in ms (migration 137) — drives the stat-first scanner.
   * Omitted/null keeps the stored value (COALESCE) so callers without a
   * fresh stat (force re-scan) don't regress it to NULL.
   */
  mtimeMs?: number | null;
}

export function upsert(db: DB, projectId: number, data: UpsertFileData): number {
  const tx = db.transaction(() => {
    const existing = db.prepare(
      'SELECT id FROM files WHERE project_id = ? AND path = ?'
    ).get(projectId, data.path) as { id: number } | undefined;

    let fileId: number;

    if (existing) {
      fileId = existing.id;
      db.prepare(`
        UPDATE files SET
          language = ?, size = ?, line_count = ?, content_hash = ?,
          dependencies = COALESCE(?, dependencies),
          internal_deps = COALESCE(?, internal_deps),
          external_deps = COALESCE(?, external_deps),
          is_entry_point = COALESCE(?, is_entry_point),
          is_test = COALESCE(?, is_test),
          is_generated = COALESCE(?, is_generated),
          index_tier = COALESCE(?, index_tier),
          mapper_reason = COALESCE(?, mapper_reason),
          mtime_ms = COALESCE(?, mtime_ms),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        data.language, data.size, data.lineCount, data.contentHash,
        data.dependencies ? JSON.stringify(data.dependencies) : null,
        data.internalDeps ? JSON.stringify(data.internalDeps) : null,
        data.externalDeps ? JSON.stringify(data.externalDeps) : null,
        data.isEntryPoint === undefined ? null : Number(data.isEntryPoint),
        data.isTest === undefined ? null : Number(data.isTest),
        data.isGenerated === undefined ? null : Number(data.isGenerated),
        data.indexTier ?? null, data.mapperReason ?? null,
        data.mtimeMs ?? null,
        existing.id
      );
    } else {
      const result = db.prepare(`
        INSERT INTO files (project_id, path, language, size, line_count, content_hash,
          dependencies, internal_deps, external_deps,
          is_entry_point, is_test, is_generated, index_tier, mapper_reason, mtime_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId, data.path, data.language, data.size, data.lineCount, data.contentHash,
        JSON.stringify(data.dependencies ?? []), JSON.stringify(data.internalDeps ?? []),
        JSON.stringify(data.externalDeps ?? []), Number(data.isEntryPoint ?? false),
        Number(data.isTest ?? false), Number(data.isGenerated ?? false),
        data.indexTier ?? null, data.mapperReason ?? null, data.mtimeMs ?? null
      );
      fileId = result.lastInsertRowid as number;
    }

    return fileId;
  });

  return tx();
}

export function get(db: DB, projectId: number, path: string): DBFile | undefined {
  return db.prepare('SELECT * FROM files WHERE project_id = ? AND path = ?')
    .get(projectId, path) as DBFile | undefined;
}

export function getById(db: DB, id: number): DBFile | undefined {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as DBFile | undefined;
}

export function list(db: DB, projectId: number, language?: string): DBFile[] {
  if (language) {
    return db.prepare('SELECT * FROM files WHERE project_id = ? AND language = ? ORDER BY path')
      .all(projectId, language) as DBFile[];
  }
  return db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY path')
    .all(projectId) as DBFile[];
}

export interface FileScanMeta {
  path: string;
  content_hash: string;
  mtime_ms: number | null;
  size: number;
}

/**
 * Slim per-file metadata for the stat-first scanner — 4 columns instead of
 * the full row; reconciliation needs only filesystem identity metadata.
 */
export function listScanMeta(db: DB, projectId: number): FileScanMeta[] {
  return db.prepare(
    'SELECT path, content_hash, mtime_ms, size FROM files WHERE project_id = ?'
  ).all(projectId) as FileScanMeta[];
}

/**
 * Stamp a fresh mtime on an unchanged file (hash matched after a read) so
 * the NEXT scan takes the stat-only shortcut. Also the automatic backfill
 * path for rows created before migration 137.
 */
export function touchMtime(db: DB, projectId: number, path: string, mtimeMs: number): void {
  db.prepare('UPDATE files SET mtime_ms = ? WHERE project_id = ? AND path = ?')
    .run(mtimeMs, projectId, path);
}

export function del(db: DB, projectId: number, path: string): void {
  db.prepare('DELETE FROM files WHERE project_id = ? AND path = ?').run(projectId, path);
}

export function delByProject(db: DB, projectId: number): void {
  db.prepare('DELETE FROM files WHERE project_id = ?').run(projectId);
}

export function search(db: DB, projectId: number, query: string, limit: number = 20): DBFile[] {
  return db.prepare(`
    SELECT f.* FROM files_fts fts
    JOIN files f ON f.id = fts.rowid
    WHERE fts.files_fts MATCH ? AND f.project_id = ?
    ORDER BY rank
    LIMIT ?
  `).all(query, projectId, limit) as DBFile[];
}
