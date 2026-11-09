/**
 * End-to-end integration for the tiered-hybrid split through the REAL
 * `CodeIndexDB` class (not the engine in isolation): flag gating, db_path
 * stamping, the pool resolver, `ensureProjectSplit`, the marker state machine,
 * and the `useProjectDb` routing predicate — exercised exactly as the app wires
 * them. Proves flag-OFF is inert and flag-ON migrates + verifies safely.
 *
 * ABI: needs `pnpm node:rebuild`.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Trigger config.ts's `import 'dotenv/config'` ONCE at file load, so the repo's
// .env (which may set MCP_PROJECT_DB=1) is applied before any test. After this,
// our hooks fully control the flags — dotenv won't re-run (module cached).
import '@mcp/shared/utils/config.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-pdb-int-'));
  dirs.push(d);
  return d;
}

function clearFlags(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('MCP_PROJECT_DB') || k.startsWith('MCP_DB_SPLIT')) delete process.env[k];
  }
}
beforeEach(clearFlags);
afterEach(() => {
  clearFlags();
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Fresh import of CodeIndexDB AFTER env is set (flags are read at construction). */
async function freshDb(centralPath: string) {
  const { CodeIndexDB } = await import('../db.js');
  return new CodeIndexDB(centralPath);
}

function seedProjectWithFiles(db: any, name: string, root: string): number {
  const p = db.createProject(name, root);
  const ins = db.raw().prepare(`INSERT INTO files (project_id, path, content_hash) VALUES (?,?,?)`);
  ins.run(p.id, 'src/a.ts', 'ha');
  ins.run(p.id, 'src/b.ts', 'hb');
  return p.id;
}

describe('CodeIndexDB tiered-hybrid integration', () => {
  it('observes a split committed by another handle after the reader cached central routing', async () => {
    process.env.MCP_PROJECT_DB = '1';
    process.env.MCP_PROJECT_DB_SPLIT = '1';
    process.env.MCP_PROJECT_DB_ROUTE = '1';
    const dir = freshDir();
    const path = join(dir, 'index.db');
    const reader = await freshDb(path);
    const id = reader.createProject('cross-handle', join(dir, 'project')).id;
    const writer = await freshDb(path);
    try {
      expect(reader.searchFilePaths(id, 'AfterSplit')).toEqual([]);
      expect(reader.getStructuralRevision(id)).toBe('empty');
      expect(writer.ensureProjectSplit(id)?.status).toBe('done');
      writer.upsertFileStructural(id, { path: 'AfterSplit.ts', language: 'typescript',
        size: 12, lineCount: 1, contentHash: 'new', mtimeMs: null });
      expect(reader.searchFilePaths(id, 'AfterSplit')).toEqual([{ path: 'AfterSplit.ts' }]);
      expect(reader.getStructuralRevision(id)).toBe(writer.getStructuralRevision(id));
      expect(reader.getStructuralRevision(id)).not.toBe('empty');
      // A rollback of routing in another connection must invalidate a cached
      // positive decision too, without relying on a main-thread callback.
      writer.setProjectSplitStatus(id, 'pending');
      expect(reader.useProjectDb(id)).toBe(false);
      expect(reader.searchFilePaths(id, 'AfterSplit')).toEqual([]);
    } finally { writer.close(); reader.close(); }
  });
  it('flag OFF: ensureProjectSplit is inert, useProjectDb=false, no project DB file', async () => {
    const dir = freshDir();
    const db = await freshDb(join(dir, 'index.db'));
    try {
      const root = join(dir, 'projA');
      const id = seedProjectWithFiles(db, 'projA', root);
      expect(db.ensureProjectSplit(id)).toBeNull(); // no-op when flag off
      expect(db.useProjectDb(id)).toBe(false);
      expect(existsSync(join(root, '.mcp-indexer', 'index.db'))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('flag ON: migrates an existing project, verifies, flips routing, keeps central intact', async () => {
    const dir = freshDir();
    process.env.MCP_PROJECT_DB = '1';
    process.env.MCP_PROJECT_DB_SPLIT = '1';
    process.env.MCP_PROJECT_DB_ROUTE = '1'; // P2b: enable read/write routing
    const central = join(dir, 'index.db');
    const db = await freshDb(central);
    try {
      const root = join(dir, 'projB');
      const id = seedProjectWithFiles(db, 'projB', root);

      // Pending → routing still central until migrated.
      expect(db.getProjectSplitStatus(id)).toBe('pending');
      expect(db.useProjectDb(id)).toBe(false);

      const outcome = db.ensureProjectSplit(id);
      expect(outcome?.status).toBe('done');
      expect(outcome?.copied).toBe(2);

      // Marker flipped + routing now targets the project DB.
      expect(db.getProjectSplitStatus(id)).toBe('done');
      expect(db.useProjectDb(id)).toBe(true);

      // The project DB exists at the stamped path and holds the project's files.
      const projDbPath = db.resolveProjectDbPath(id);
      expect(projDbPath).toBe(join(root, '.mcp-indexer', 'index.db'));
      expect(existsSync(projDbPath)).toBe(true);
      const proj = db.forProject(id).raw();
      expect((proj.prepare(`SELECT COUNT(*) n FROM files`).get() as { n: number }).n).toBe(2);

      // Central is untouched (purge deferred).
      expect((db.raw().prepare(`SELECT COUNT(*) n FROM files WHERE project_id=?`).get(id) as { n: number }).n).toBe(2);

      // Idempotent: second call is a no-op.
      expect(db.ensureProjectSplit(id)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('flag ON: after migration, writes + reads route to the project DB (central untouched)', async () => {
    const dir = freshDir();
    process.env.MCP_PROJECT_DB = '1';
    process.env.MCP_PROJECT_DB_SPLIT = '1';
    process.env.MCP_PROJECT_DB_ROUTE = '1'; // P2b: enable read/write routing
    const central = join(dir, 'index.db');
    const db = await freshDb(central);
    try {
      const root = join(dir, 'projD');
      const id = seedProjectWithFiles(db, 'projD', root); // 2 files in central
      expect(db.ensureProjectSplit(id)?.status).toBe('done');
      expect(db.useProjectDb(id)).toBe(true);

      // A NEW structural write goes through the routed handle → project DB.
      const { fileId } = db.upsertFileStructural(id, {
        path: 'src/new.ts', language: 'ts', size: 10, lineCount: 1,
        contentHash: 'hn', mtimeMs: null,
      });

      // Bare-id read WITH projectId routes to the project DB and finds it.
      expect(db.getFileById(fileId, id)?.path).toBe('src/new.ts');
      // Bare-id read WITHOUT projectId hits central → the new row isn't there.
      expect(db.getFileById(fileId)).toBeUndefined();

      // Read-back via routed listFiles sees all 3 (2 copied + 1 new).
      const paths = db.listFiles(id).map((f: any) => f.path).sort();
      expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts']);
      expect((db.forProject(id).raw().prepare(`SELECT COUNT(*) n FROM files`).get() as { n: number }).n).toBe(3);

      // Central still has only the original 2 — the new write did NOT touch it.
      expect((db.raw().prepare(`SELECT COUNT(*) n FROM files WHERE project_id=?`).get(id) as { n: number }).n).toBe(2);
    } finally {
      db.close();
    }
  });

  it('flag ON: clearProjectData + deleteProject remove the project DB files (app-layer cascade)', async () => {
    const dir = freshDir();
    process.env.MCP_PROJECT_DB = '1';
    process.env.MCP_PROJECT_DB_SPLIT = '1';
    process.env.MCP_PROJECT_DB_ROUTE = '1';
    const db = await freshDb(join(dir, 'index.db'));
    try {
      const root = join(dir, 'projE');
      const id = seedProjectWithFiles(db, 'projE', root);
      db.ensureProjectSplit(id);
      const projDbPath = join(root, '.mcp-indexer', 'index.db');
      expect(existsSync(projDbPath)).toBe(true);
      expect(db.listFiles(id).length).toBe(2);

      // clearProjectData wipes the project DB (fresh empty reopens) + resets counters.
      db.clearProjectData(id);
      expect(db.listFiles(id).length).toBe(0); // reopened empty
      expect(db.getProject(id)?.id).toBe(id);  // row kept

      // deleteProject removes the files + the central catalog row.
      db.upsertFileStructural(id, { path: 'x.ts', language: 'ts', size: 1, lineCount: 1, contentHash: 'h', mtimeMs: null });
      db.deleteProject(id);
      expect(db.getProject(id)).toBeUndefined();
      expect(existsSync(projDbPath)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('flag ON + NEW project: born already-migrated (db_path stamped, status done)', async () => {
    const dir = freshDir();
    process.env.MCP_PROJECT_DB = '1';
    process.env.MCP_PROJECT_DB_NEW = '1';
    process.env.MCP_PROJECT_DB_ROUTE = '1'; // P2b: enable read/write routing
    const db = await freshDb(join(dir, 'index.db'));
    try {
      const root = join(dir, 'projC');
      const p = db.createProject('projC', root);
      expect(db.getProjectSplitStatus(p.id)).toBe('done');
      expect(db.useProjectDb(p.id)).toBe(true);
    } finally {
      db.close();
    }
  });
});
