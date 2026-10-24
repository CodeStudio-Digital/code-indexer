import type { DB } from './types.js';

export interface RepoMapPageInput { offset?: number; limit?: number; order?: 'ranked' | 'recent' }
export interface RepoMapSymbol { name: string; kind: string; line: number; signature: string; signature_characters: number }
export interface RepoMapFile {
  id: number; path: string; score: number; is_entry_point: number; dependent_count: number; symbol_count: number; symbols: RepoMapSymbol[];
}

/** Ranking is computed by aggregate SQL. Only the requested file page and its
 * bounded symbol previews cross the SQLite boundary; no per-file full reads. */
export function repoMapPage(db: DB, projectId: number, input: RepoMapPageInput = {}) {
  const offset = input.offset ?? 0, limit = input.limit ?? 100, order = input.order ?? 'ranked';
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || !['ranked', 'recent'].includes(order)) throw new Error('Invalid repo map page');
  return db.transaction(() => {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM files WHERE project_id=?').get(projectId) as { n: number }).n;
    let files: RepoMapFile[];
    const kinds = order === 'recent' ? "'function','class','interface','type','enum','module'" : "'function','class','interface','method','type'";
    const symbolFilter = `kind IN (${kinds})` + (order === 'recent' ? " AND (parent IS NULL OR parent='')" : '');
    if (order === 'recent') {
      files = db.prepare(`SELECT id,path,0 AS score,is_entry_point,0 AS dependent_count,0 AS symbol_count
        FROM files WHERE project_id=? ORDER BY updated_at DESC,path,id LIMIT ? OFFSET ?`).all(projectId, limit, offset) as RepoMapFile[];
    } else {
      files = db.prepare(`WITH deps AS (
        SELECT target_file_id AS id,COUNT(DISTINCT source_file_id) AS n FROM file_dependencies
        WHERE project_id=? AND target_file_id IS NOT NULL GROUP BY target_file_id
      ), syms AS (
        SELECT file_id AS id,COUNT(*) AS n FROM symbols WHERE project_id=? AND ${symbolFilter} GROUP BY file_id
      ), names AS (
        SELECT id,path,is_entry_point,lower(substr(path,length(rtrim(path,replace(path,'/','')))+1)) AS name FROM files WHERE project_id=?
      ), scored AS (
        SELECT f.id,f.path,CASE WHEN f.is_entry_point=1 OR f.name IN ('package.json','pyproject.toml','cargo.toml','go.mod')
          OR f.name GLOB 'index.*' OR f.name GLOB 'main.*' OR f.name GLOB 'app.*' OR f.name GLOB 'server.*' OR f.name GLOB 'cli.*'
          THEN 1 ELSE 0 END AS is_entry_point,coalesce(d.n,0) AS dependent_count,coalesce(s.n,0) AS symbol_count
        FROM names f LEFT JOIN deps d ON d.id=f.id LEFT JOIN syms s ON s.id=f.id
      ) SELECT *,dependent_count*3+is_entry_point*10+min(symbol_count,10) AS score
        FROM scored ORDER BY score DESC,path,id LIMIT ? OFFSET ?`).all(projectId, projectId, projectId, limit, offset) as RepoMapFile[];
    }
    if (files.length) {
      const ids = files.map(f => f.id), placeholders = ids.map(() => '?').join(','), perFile = order === 'recent' ? 6 : 3;
      const rows = db.prepare(`WITH ranked AS (
        SELECT file_id,name,kind,line,substr(coalesce(signature,name),1,80) AS signature,
          length(coalesce(signature,name)) AS signature_characters,
          row_number() OVER (PARTITION BY file_id ORDER BY line,id) AS rank,
          count(*) OVER (PARTITION BY file_id) AS total
        FROM symbols WHERE project_id=? AND file_id IN (${placeholders}) AND ${symbolFilter}
      ) SELECT file_id,name,kind,line,signature,signature_characters,total FROM ranked WHERE rank<=? ORDER BY file_id,rank`)
        .all(projectId, ...ids, perFile) as Array<RepoMapSymbol & { file_id: number; total: number }>;
      const byId = new Map(files.map(f => { f.symbols = []; return [f.id, f] as const; }));
      for (const { file_id, total: symbolTotal, ...symbol } of rows) {
        const file = byId.get(file_id)!; file.symbols.push(symbol); file.symbol_count = symbolTotal;
      }
    }
    return { items: files, total, offset, ...(offset + files.length < total ? { nextOffset: offset + files.length } : {}) };
  })();
}
