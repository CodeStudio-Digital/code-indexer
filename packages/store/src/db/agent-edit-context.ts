import type { DB } from './types.js';
import type { OutlineSymbol } from './agent-symbol-reads.js';

export interface EditContextPage { importsOffset: number; testsOffset: number; importsLimit: number; testsLimit: number }
export function editContext(db: DB, projectId: number, path: string, line: number, page: EditContextPage) {
  for (const n of [page.importsOffset, page.testsOffset]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid edit-context offset');
  for (const n of [page.importsLimit, page.testsLimit]) if (!Number.isSafeInteger(n) || n < 1 || n > 100) throw new Error('Invalid edit-context limit');
  return db.transaction(() => {
    const file = db.prepare('SELECT id FROM files WHERE project_id=? AND path=?').get(projectId, path) as { id: number } | undefined;
    if (!file) return { indexed: false, neighbors: [] as OutlineSymbol[], imports: { total: 0, items: [] as string[] }, tests: { total: 0, items: [] as string[] } };
    const fields = 'file_path,line,end_line,kind,name,signature,parent,stable_id';
    const before = db.prepare(`SELECT ${fields} FROM symbols WHERE project_id=? AND file_id=? AND line<? ORDER BY line DESC,id DESC LIMIT 3`)
      .all(projectId, file.id, line) as OutlineSymbol[];
    const after = db.prepare(`SELECT ${fields} FROM symbols WHERE project_id=? AND file_id=? AND line>=? ORDER BY line,id LIMIT 4`)
      .all(projectId, file.id, line) as OutlineSymbol[];
    const importTotal = (db.prepare('SELECT COUNT(DISTINCT import_path) AS n FROM file_dependencies WHERE project_id=? AND source_file_id=?')
      .get(projectId, file.id) as { n: number }).n;
    const imports = db.prepare('SELECT DISTINCT import_path AS path FROM file_dependencies WHERE project_id=? AND source_file_id=? ORDER BY import_path LIMIT ? OFFSET ?')
      .all(projectId, file.id, page.importsLimit, page.importsOffset) as Array<{ path: string }>;
    const testsFrom = 'FROM file_dependencies d JOIN files f ON f.id=d.source_file_id AND f.project_id=d.project_id WHERE d.project_id=? AND d.target_file_id=? AND f.is_test=1';
    const testTotal = (db.prepare('SELECT COUNT(DISTINCT f.path) AS n ' + testsFrom).get(projectId, file.id) as { n: number }).n;
    const tests = db.prepare('SELECT DISTINCT f.path AS path ' + testsFrom + ' ORDER BY f.path LIMIT ? OFFSET ?')
      .all(projectId, file.id, page.testsLimit, page.testsOffset) as Array<{ path: string }>;
    return { indexed: true, neighbors: [...before.reverse(), ...after], imports: { total: importTotal, items: imports.map(r => r.path) },
      tests: { total: testTotal, items: tests.map(r => r.path) } };
  })();
}
