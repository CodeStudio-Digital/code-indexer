import type { DBFile } from '@mcp/shared/types.js';
import type { DB } from './types.js';

export type EmbeddingFile = Pick<DBFile, 'id' | 'path' | 'language'>;
export interface EmbeddingFileBounds { total: number; maxId: number }
export type EmbeddingBoundsQuery = { kind: 'bounds'; folders: readonly string[] };
export type EmbeddingPageQuery =
  | { kind: 'page'; folder: string; after: string; maxId: number }
  | { kind: 'paths'; paths: readonly string[] };
export type EmbeddingFileQuery = EmbeddingBoundsQuery | EmbeddingPageQuery;
export type EmbeddingFileResult = EmbeddingFileBounds | EmbeddingFile[];
export const EMBEDDING_PAGE_SIZE = 256;

/** Uses the (project_id, path) index and never holds a read transaction during inference. */
export function readEmbeddingFiles(db: DB, projectId: number, query: EmbeddingFileQuery): EmbeddingFileResult {
  if (query.kind === 'bounds') {
    return db.transaction(() => {
      const result: EmbeddingFileBounds = { total: 0, maxId: 0 };
      for (const folder of query.folders) {
        const scoped = folder !== '.';
        const row = db.prepare('SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS maxId FROM files WHERE project_id = ?'
          + (scoped ? ' AND path >= ? AND path < ?' : ''))
          .get(...(scoped ? [projectId, folder + '/', folder + '0'] : [projectId])) as EmbeddingFileBounds;
        result.total += row.total;
        result.maxId = Math.max(result.maxId, row.maxId);
      }
      return result;
    })();
  }
  const select = 'SELECT id, path, language FROM files WHERE project_id = ?';
  if (query.kind === 'paths') {
    if (!query.paths.length) return [];
    if (query.paths.length > EMBEDDING_PAGE_SIZE) throw new Error('Embedding file page is too large');
    return db.prepare(select + ' AND path IN (' + query.paths.map(() => '?').join(',') + ') ORDER BY path')
      .all(projectId, ...query.paths) as EmbeddingFile[];
  }
  const scoped = query.folder !== '.';
  return db.prepare(select + ' AND path > ? AND id <= ?' + (scoped ? ' AND path >= ? AND path < ?' : '')
    + ' ORDER BY path LIMIT ?').all(projectId, query.after, query.maxId,
      ...(scoped ? [query.folder + '/', query.folder + '0'] : []), EMBEDDING_PAGE_SIZE) as EmbeddingFile[];
}
