/**
 * R1 — the FEATURE class of the db-split manifest copies project-scoped feature
 * data (API client, file local history) into the project DB, with the custom
 * `where` subqueries (child tables via parent, shared blob pool) selecting only
 * THIS project's rows. Validates the new manifest `where` clauses end-to-end.
 *
 * ABI: needs `pnpm node:rebuild`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRawProjectDb, initProjectSchema } from '../project-db/index.js';
import { splitProject } from '../db-split/index.js';
import { ApiClientStore } from '../api-client-store.js';
import type { DB } from '../db/types.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-feat-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function openFresh(path: string): DB {
  const db = openRawProjectDb(path);
  initProjectSchema(db);
  return db;
}

describe('db-split FEATURE class (R1)', () => {
  it('copies the project API client + file history; excludes the other project', () => {
    const dir = freshDir();
    const centralPath = join(dir, 'index.db');
    const projPath = join(dir, 'p1', '.mcp-indexer', 'index.db');
    const central = openFresh(centralPath);
    try {
      central.exec(`
        INSERT INTO projects (id, name, root_path) VALUES (1,'p1','/p1'),(2,'p2','/p2');
      `);
      // API client — seed via the store so column sets stay correct.
      const api = new ApiClientStore(central);
      const c1 = api.createCollection({ project_id: 1, name: 'col-p1' });
      api.createRequest({ collection_id: c1.id, name: 'req-1', method: 'GET', path_template: '/a' });
      api.upsertEnvironment({ project_id: 1, name: 'dev', base_url: 'http://x' });
      api.createCollection({ project_id: 2, name: 'col-p2' }); // must NOT be copied
      // File local history + a referenced content-addressed blob (shared pool).
      central.exec(`INSERT INTO file_history_blobs (hash, content, size, refcount) VALUES ('h1','x',1,1),('h2','y',1,1)`);
      central.exec(`INSERT INTO file_local_history (project_id, path, content_hash, size, kind) VALUES (1,'a.ts','h1',1,'save'),(2,'b.ts','h2',1,'save')`);

      const outcome = splitProject({
        central, centralDbPath: centralPath, projectDbPath: projPath, projectId: 1,
        openFreshProjectDb: openFresh, classes: ['INDEX', 'FEATURE'],
      });
      expect(outcome.status, `split failed: ${outcome.reason}`).toBe('done');

      const proj = openRawProjectDb(projPath, { readonly: true });
      try {
        // Only p1's collection + its request + env.
        const cols = (proj.prepare('SELECT name FROM api_collections').all() as { name: string }[]).map((r) => r.name);
        expect(cols).toEqual(['col-p1']); // not col-p2
        expect((proj.prepare('SELECT COUNT(*) n FROM api_requests').get() as { n: number }).n).toBe(1);
        expect((proj.prepare('SELECT COUNT(*) n FROM api_environments').get() as { n: number }).n).toBe(1);
        // File history: only p1's row + only the blob it references (h1, not h2).
        expect((proj.prepare("SELECT path FROM file_local_history").get() as { path: string }).path).toBe('a.ts');
        const blobs = (proj.prepare('SELECT hash FROM file_history_blobs ORDER BY hash').all() as { hash: string }[]).map((r) => r.hash);
        expect(blobs).toEqual(['h1']); // h2 belongs to p2 — not copied
      } finally {
        proj.close();
      }

      // Central untouched (purge deferred): both collections still there.
      expect((central.prepare('SELECT COUNT(*) n FROM api_collections').get() as { n: number }).n).toBe(2);
    } finally {
      central.close();
    }
  });
});
