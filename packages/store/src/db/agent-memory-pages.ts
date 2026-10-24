import type { DB } from './types.js';

export interface MemoryContentPage {
  id: number; name: string; type: string; content: string; content_characters: number;
  source: string; importance: number;
}
/** Scope, liveness and content bounds are applied before rows leave SQLite.
 * The requested IDs may come from an out-of-process semantic ranker. */
export function projectMemoryPages(db: DB, projectId: number, ids: readonly number[], offset: number, limit: number): MemoryContentPage[] {
  if (ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id < 1)
    || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16384) throw new Error('Invalid memory content page');
  if (!ids.length) return [];
  return db.prepare(`SELECT id,name,type,substr(content,?,?) AS content,length(content) AS content_characters,source,importance
    FROM agent_memory WHERE scope='project' AND project_id=? AND archived_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`)
    .all(offset + 1, limit, projectId, ...ids) as MemoryContentPage[];
}
