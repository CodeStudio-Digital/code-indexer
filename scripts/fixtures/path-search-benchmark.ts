import { createRequire } from 'node:module';
import { searchPaths } from '@mcp/store/db/files.js';
import { pathCandidates272 } from '@mcp/store/migrations/272-path-candidates.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE files(id INTEGER PRIMARY KEY, project_id INTEGER, path TEXT, UNIQUE(project_id,path))');
const insert = db.prepare('INSERT INTO files(project_id,path) VALUES(?,?)');
db.transaction(() => {
  for (const [project, size] of [[1, 10_000], [2, 150_000]]) {
    for (let index = 0; index < size; index++) insert.run(project, `src/benchmark/Target${String(index).padStart(6, '0')}.tsx`);
  }
})();
pathCandidates272.up(db);
process.on('message', (message: { id: number; projectId: number; query: string; limit: number }) => {
  const started = performance.now();
  const items = searchPaths(db, message.projectId, message.query, message.limit);
  process.send?.({ id: message.id, items, sqlMs: performance.now() - started });
});
process.on('disconnect', () => { db.close(); process.exit(0); });
process.send?.({ ready: true });
