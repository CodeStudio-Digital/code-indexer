import type { DB } from './types.js';

export interface SemanticSymbol { id: number; project_id: number; name: string; kind: string; file_path: string; line: number | null }
export interface SemanticSeed extends SemanticSymbol { signature: string | null; comment: string | null }
const columns = 'id, project_id, name, kind, file_path, line';
export function seed(db: DB, id: number, projectId?: number) {
  const where = 'id=?' + (projectId == null ? '' : ' AND project_id=?');
  return db.prepare('SELECT ' + columns + ', substr(signature,1,512) AS signature, substr(comment,1,1024) AS comment FROM symbols WHERE ' + where)
    .get(...(projectId == null ? [id] : [id, projectId])) as SemanticSeed | undefined;
}
export function neighbors(db: DB, projectId: number, ids: number[]) {
  if (ids.length > 52 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid semantic neighbor ids');
  if (!ids.length) return [];
  return db.prepare('SELECT ' + columns + ' FROM symbols WHERE project_id=? AND id IN (' + ids.map(() => '?').join(',') + ')')
    .all(projectId, ...ids) as SemanticSymbol[];
}
