import type { DBFile } from '@mcp/shared/types.js';
import type { DB } from './types.js';

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
