import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { searchPaths } from '../files.js';

const Database = createRequire(import.meta.url)('better-sqlite3');

describe('bounded file path search', () => {
  it('ranks basename/substring ahead of subsequence matches and isolates projects', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE files(project_id INTEGER, path TEXT, UNIQUE(project_id, path))');
      const insert = db.prepare('INSERT INTO files VALUES (?, ?)');
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
