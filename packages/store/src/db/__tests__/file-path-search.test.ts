import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { searchPaths, listPathsBounded } from '../files.js';
import { pathCandidates272 } from '../../migrations/272-path-candidates.js';

const Database = createRequire(import.meta.url)('better-sqlite3');

describe('bounded file path search', () => {
  it('acquires path-only pages with a truncation probe and language/project isolation', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE files(project_id INTEGER,path TEXT,language TEXT); INSERT INTO files VALUES(1,'a.ts','typescript'),(1,'b.ts','typescript'),(1,'c.py','python'),(2,'foreign.ts','typescript')");
      expect(listPathsBounded(db, 1, 'typescript', 1)).toEqual({ paths: ['a.ts'], truncated: true });
      expect(listPathsBounded(db, 1, 'python', 10)).toEqual({ paths: ['c.py'], truncated: false });
    } finally { db.close(); }
  });
  it('ranks basename/substring ahead of subsequence matches and isolates projects', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE files(id INTEGER PRIMARY KEY, project_id INTEGER, path TEXT, UNIQUE(project_id, path))');
      pathCandidates272.up(db);
      const insert = db.prepare('INSERT INTO files(project_id,path) VALUES (?, ?)');
      for (const path of ['src/Workspace.tsx', 'Workspace.tsx', 'src/workspace-tools.ts', 'src/weird-long-space.ts', 'a_b.ts', 'a%b.ts']) insert.run(1, path);
      insert.run(2, 'workspace.ts');
      expect(searchPaths(db, 1, 'workspace', 2)).toEqual([{ path: 'Workspace.tsx' }, { path: 'src/Workspace.tsx' }]);
      expect(searchPaths(db, 1, 'wstx', 10).map((r) => r.path)).toContain('src/Workspace.tsx');
      expect(searchPaths(db, 1, 'wstx', 10, false)).toEqual([]);
      expect(searchPaths(db, 1, '_', 50)).toEqual([{ path: 'a_b.ts' }]);
      expect(searchPaths(db, 1, '%', 50)).toEqual([{ path: 'a%b.ts' }]);
      expect(searchPaths(db, 1, "' OR 1=1 --")).toEqual([]);
      expect(searchPaths(db, 1, '   ')).toEqual([]);
      db.transaction(() => { for (let i = 0; i < 1000; i++) insert.run(1, `file-${i}.ts`); })();
      expect(searchPaths(db, 1, 'file', 9999)).toHaveLength(300);
      expect(searchPaths(db, 1, 'file', NaN)).toHaveLength(50);
    } finally { db.close(); }
  });
});
