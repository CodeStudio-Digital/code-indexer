import type { DB } from './types.js';

export interface ReferencePageInput { offset: number; limit: number; targetFile?: string; referenceKind?: 'all' | 'call' | 'import' | 'unknown' }
export interface ReferenceSummary { file_path: string; line: number | null; col: number | null; context: string | null; context_truncated: number; context_characters: number; reference_kind: 'call' | 'import' | null }

/** Name-based references are not resolved by symbol_id: older indexers attached
 * that id to the first matching name, which is not semantic disambiguation. */
export function referencePage(db: DB, projectId: number, name: string, input: ReferencePageInput) {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.limit)
    || input.limit < 1 || input.limit > 500) throw new Error('Invalid reference page');
  const kind = input.referenceKind ?? 'all';
  if (!['all', 'call', 'import', 'unknown'].includes(kind)) throw new Error('Invalid reference kind');
  const filter = kind === 'all' ? '' : kind === 'unknown' ? ' AND reference_kind IS NULL' : ' AND reference_kind=?';
  const where = 'project_id=? AND symbol_name=?' + filter;
  const queryArgs: Array<string | number> = [projectId, name, ...(['call', 'import'].includes(kind) ? [kind] : [])];
  return db.transaction(() => {
    const total = (db.prepare('SELECT COUNT(*) AS n FROM symbol_references WHERE ' + where).get(...queryArgs) as { n: number }).n;
    const args: Array<string | number> = [...queryArgs];
    let order = '';
    if (input.targetFile) {
      const slash = input.targetFile.lastIndexOf('/'), prefix = slash < 0 ? '' : input.targetFile.slice(0, slash + 1);
      order = `CASE WHEN referencing_file_path=? THEN 0 WHEN substr(referencing_file_path,1,?)=?
        AND instr(substr(referencing_file_path,?),'/')=0 THEN 1 ELSE 2 END, `;
      args.push(input.targetFile, prefix.length, prefix, prefix.length + 1);
    }
    const items = db.prepare(`SELECT referencing_file_path AS file_path, line, col, reference_kind, substr(context,1,1024) AS context,
      CASE WHEN length(context)>1024 THEN 1 ELSE 0 END AS context_truncated, coalesce(length(context),0) AS context_characters
      FROM symbol_references WHERE ${where}
      ORDER BY ${order}referencing_file_path, line, col, id LIMIT ? OFFSET ?`).all(...args, input.limit, input.offset) as ReferenceSummary[];
    return { total, items, offset: input.offset };
  })();
}
