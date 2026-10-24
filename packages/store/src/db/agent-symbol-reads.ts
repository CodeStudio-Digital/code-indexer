import type { DB } from './types.js';
import type { DBFile, DBSymbol } from '@mcp/shared/types.js';

export interface SymbolPageInput { offset: number; limit: number; kind?: string }
export type OutlineSymbol = Pick<DBSymbol, 'file_path' | 'line' | 'end_line' | 'name' | 'signature' | 'parent' | 'stable_id'> & { kind: string };
type OutlineFile = Pick<DBFile, 'path' | 'language' | 'line_count' | 'size' | 'content_hash'>;

export type SymbolDefinition = OutlineSymbol & Pick<DBSymbol, 'id' | 'namespace'>;
export function definitionsPage(db: DB, projectId: number, name: string, path: string | undefined, input: SymbolPageInput) {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.limit)
    || input.limit < 1 || input.limit > 500) throw new Error('Invalid symbol page');
  return db.transaction(() => {
    const where = 'project_id=? AND name=?' + (path ? ' AND file_path=?' : '');
    const args = path ? [projectId, name, path] : [projectId, name];
    const total = (db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE ' + where).get(...args) as { n: number }).n;
    const items = db.prepare('SELECT id, file_path, line, end_line, kind, name, signature, parent, stable_id, namespace FROM symbols WHERE '
      + where + ' ORDER BY file_path, line, id LIMIT ? OFFSET ?').all(...args, input.limit, input.offset) as SymbolDefinition[];
    return { items, total, offset: input.offset };
  })();
}

export function skeletonPage(db: DB, projectId: number, path: string, input: SymbolPageInput) {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.limit)
    || input.limit < 1 || input.limit > 500) throw new Error('Invalid symbol page');
  return db.transaction(() => {
    const file = db.prepare('SELECT path, language, line_count, size, content_hash FROM files WHERE project_id=? AND path=?')
      .get(projectId, path) as OutlineFile | undefined;
    const prefix = path ? path + '/' : '';
    const files = file ? 1 : (db.prepare('SELECT COUNT(*) AS n FROM files WHERE project_id=? AND substr(path,1,?)=?')
      .get(projectId, prefix.length, prefix) as { n: number }).n;
    const where = 'project_id=? AND ' + (file ? 'file_path=?' : 'substr(file_path,1,?)=? AND exported=1')
      + (input.kind ? ' AND kind=?' : '');
    const args = file ? [projectId, path] : [projectId, prefix.length, prefix];
    if (input.kind) args.push(input.kind);
    const total = (db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE ' + where).get(...args) as { n: number }).n;
    const symbols = db.prepare('SELECT file_path, line, end_line, kind, name, signature, parent, stable_id FROM symbols WHERE '
      + where + ' ORDER BY file_path, line, id LIMIT ? OFFSET ?').all(...args, input.limit, input.offset) as OutlineSymbol[];
    return { file, files, symbols, total, offset: input.offset,
      ...(input.offset + symbols.length < total ? { nextOffset: input.offset + symbols.length } : {}) };
  })();
}
