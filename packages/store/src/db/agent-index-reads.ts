import type { DB } from './types.js';
import type { DBFileDependency, DBFileDependent } from '@mcp/shared/types.js';

export interface IndexPage { offset?: number; limit?: number }
export interface IndexFileRow { path: string; language: string; line_count: number; updated_at: string }
type Shape = { topDirectories: Array<{ path: string; files: number }>; keyFiles: string[] };
const shapeCache = new WeakMap<DB, Map<number, { revision: string; shape: Shape }>>();
const copyShape = (shape: Shape): Shape => ({ topDirectories: shape.topDirectories.map(row => ({ ...row })), keyFiles: [...shape.keyFiles] });
function bounds(page: IndexPage) {
  const offset = page.offset ?? 0, limit = page.limit ?? 200;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid index page: offset >= 0, limit 1..500');
  return { offset, limit };
}
function pageResult<T>(items: T[], total: number, page: { offset: number; limit: number }) {
  return { items, total, offset: page.offset, ...(page.offset + items.length < total ? { nextOffset: page.offset + items.length } : {}) };
}

/** Only metadata needed by agent navigation crosses the SQLite boundary. Count
 * and rows share a read transaction; JSON columns/bodies are never hydrated. */
export function filePage(db: DB, projectId: number, input: IndexPage & { order?: 'path' | 'updated' } = {}) {
  const page = bounds(input);
  return db.transaction(() => {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM files WHERE project_id = ?').get(projectId) as { n: number }).n;
    const order = input.order === 'updated' ? 'updated_at DESC, path, id' : 'path, id';
    const items = db.prepare(`SELECT path, language, line_count, updated_at FROM files WHERE project_id = ? ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(projectId, page.limit, page.offset) as IndexFileRow[];
    return pageResult(items, total, page);
  })();
}

/** Directory metadata only; separator-aware prefix and bounded output. */
export function directoryPage(db: DB, projectId: number, prefix: string, depth: number, input: IndexPage = {}) {
  const page = bounds(input);
  if (!Number.isInteger(depth) || depth < 0 || depth > 20) throw new Error('Directory depth must be 0..20');
  const prefixDir = prefix ? prefix + '/' : '';
  const baseDepth = prefix ? prefix.split('/').length : 0;
  const where = `project_id = ? AND (path = ? OR substr(path, 1, ?) = ?)
    AND length(path) - length(replace(path, '/', '')) <= ?`;
  const args = [projectId, prefix, prefixDir.length, prefixDir, depth + baseDepth];
  return db.transaction(() => {
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${where}`).get(...args) as { n: number }).n;
    const items = db.prepare(`SELECT path, language, line_count, updated_at FROM files WHERE ${where} ORDER BY path, id LIMIT ? OFFSET ?`)
      .all(...args, page.limit, page.offset) as IndexFileRow[];
    return pageResult(items, total, page);
  })();
}

export function dependencyPage(db: DB, projectId: number, fileId: number, reverse: boolean, input: IndexPage = {}) {
  const page = bounds(input);
  return db.transaction(() => {
    const where = reverse ? 'fd.target_file_id = ? AND fd.project_id = ?' : 'fd.source_file_id = ? AND fd.project_id = ?';
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM file_dependencies fd WHERE ${where}`).get(fileId, projectId) as { n: number }).n;
    const sql = reverse
      ? `SELECT fd.id, fd.import_path, sf.path AS source_file_path FROM file_dependencies fd JOIN files sf ON sf.id = fd.source_file_id WHERE ${where} ORDER BY sf.path, fd.import_path, fd.id LIMIT ? OFFSET ?`
      : `SELECT fd.id, fd.import_path, fd.dep_type, f.path AS target_file_path FROM file_dependencies fd LEFT JOIN files f ON f.id = fd.target_file_id WHERE ${where} ORDER BY fd.dep_type, fd.import_path, fd.id LIMIT ? OFFSET ?`;
    const items = db.prepare(sql).all(fileId, projectId, page.limit, page.offset) as Array<DBFileDependency | DBFileDependent>;
    return pageResult(items, total, page);
  })();
}

export function projectShape(db: DB, projectId: number) {
  const cacheable = !db.inTransaction;
  return db.transaction(() => {
    // data_version catches commits from other connections; total_changes catches
    // this connection. No TTL can hide an index edit. Cache only small summaries.
    const revision = String(db.pragma('data_version', { simple: true })) + ':'
      + (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    let cache = shapeCache.get(db); if (!cache) { cache = new Map(); shapeCache.set(db, cache); }
    const hit = cache.get(projectId); if (cacheable && hit?.revision === revision) return copyShape(hit.shape);
    const topDirectories = db.prepare(`WITH paths AS (SELECT replace(path, char(92), '/') AS p FROM files WHERE project_id = ?)
      SELECT CASE WHEN instr(p, '/') = 0 THEN '.' ELSE substr(p, 1, instr(p, '/') - 1) END AS path, COUNT(*) AS files
      FROM paths GROUP BY 1 ORDER BY files DESC, path LIMIT 8`).all(projectId) as Array<{ path: string; files: number }>;
    const keyFiles = db.prepare(`WITH paths AS MATERIALIZED (SELECT path, replace(path, char(92), '/') AS p FROM files WHERE project_id = ?),
      names AS MATERIALIZED (SELECT path, p, lower(substr(p, length(rtrim(p, replace(p, '/', ''))) + 1)) AS name FROM paths)
      SELECT path FROM names ORDER BY CASE
        WHEN name IN ('package.json','pyproject.toml','cargo.toml','go.mod','pom.xml','build.gradle','build.gradle.kts','readme') OR name LIKE 'readme.%' THEN 0
        WHEN name LIKE 'index.%' OR name LIKE 'main.%' OR name LIKE 'app.%' OR name LIKE 'server.%' OR name LIKE 'cli.%' THEN 1 ELSE 2 END,
        length(p) - length(replace(p, '/', '')), path LIMIT 8`).all(projectId) as Array<{ path: string }>;
    const shape = { topDirectories, keyFiles: keyFiles.map(row => row.path) };
    if (cacheable) {
      cache.delete(projectId); cache.set(projectId, { revision, shape });
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
    return copyShape(shape);
  })();
}
