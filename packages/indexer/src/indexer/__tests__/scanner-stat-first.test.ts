/**
 * Stat-first scanner: unchanged files are proven by mtime+size with ZERO
 * reads; reads happen only when the stat gate can't decide. Uses a real
 * CodeIndexDB on tmpdir (requires the Node-ABI better-sqlite3 build).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { FileScanner } from '../scanner.js';
import { indexFilesStructural } from '../structural-incremental.js';
import { runStructuralIndex } from '../structural.js';
import { hashContent } from '../content-hash.js';

let dir: string;
let root: string;
let db: CodeIndexDB;
let projectId: number;
let savedParanoid: string | undefined;

const FILES = ['a.ts', 'b.ts', 'c.ts'];

beforeEach(() => {
  savedParanoid = process.env.MCP_SCAN_PARANOID;
  delete process.env.MCP_SCAN_PARANOID;
  dir = mkdtempSync(join(tmpdir(), 'mcp-scan-'));
  root = join(dir, 'proj');
  mkdirSync(root);
  for (const f of FILES) writeFileSync(join(root, f), `export const ${f[0]} = '${f}';\n`, 'utf-8');
  db = new CodeIndexDB(join(dir, 'index.db'));
  projectId = db.createProject('scan-test', root).id;
});

afterEach(() => {
  if (savedParanoid === undefined) delete process.env.MCP_SCAN_PARANOID;
  else process.env.MCP_SCAN_PARANOID = savedParanoid;
  try { db.close(); } catch { /* */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
});

/** Persist a scanned file the way processFile's upsert does (slim version). */
function persist(file: { relativePath: string; hash: string; sizeBytes: number; lineCount: number; mtimeMs?: number }, targetProjectId = projectId): void {
  db.upsertFile(targetProjectId, {
    path: file.relativePath, language: 'typescript', size: file.sizeBytes,
    lineCount: file.lineCount, contentHash: file.hash,
    dependencies: [], internalDeps: [], externalDeps: [], mtimeMs: file.mtimeMs ?? null,
  });
}

async function scanAndPersist(scanner: FileScanner) {
  const res = await scanner.scan(db, projectId);
  for (const f of res.toIndex) persist(f);
  return res;
}

describe('FileScanner stat-first', () => {
  it('first scan hashes everything and carries no content', async () => {
    const scanner = new FileScanner(root);
    const res = await scanner.scan(db, projectId);
    expect(res.stats).toMatchObject({ hashed: FILES.length, statOnly: 0 });
    expect(res.toIndex).toHaveLength(FILES.length);
    for (const f of res.toIndex) {
      expect(f.content).toBeUndefined();
      expect(f.mtimeMs).toBeGreaterThan(0);
      expect(f.hash).toHaveLength(64);
    }
  });

  it('can plan newly discovered files without reading their contents', async () => {
    const scanner = new FileScanner(root);
    const plan = await scanner.scan(db, projectId, { deferNewFileReads: true });

    expect(plan.stats).toMatchObject({ hashed: 0, statOnly: 0 });
    expect(plan.toIndex).toHaveLength(FILES.length);
    for (const file of plan.toIndex) {
      expect(file).toHaveProperty('deferred', true);
      expect(file).not.toHaveProperty('hash');
    }
  });

  it('defers the fingerprint of every file explicitly selected for a full repair', async () => {
    const scanner = new FileScanner(root);
    await scanAndPersist(scanner);
    const plan = await scanner.scan(db, projectId, { deferNewFileReads: true, forceReparse: true });
    expect(plan.toIndex).toHaveLength(FILES.length);
    expect(plan.stats).toMatchObject({ hashed: 0, statOnly: 0 });
    expect(plan.toIndex.every(file => 'deferred' in file)).toBe(true);
  });

  it('second scan is stat-only (zero reads) when nothing changed', async () => {
    const scanner = new FileScanner(root);
    await scanAndPersist(scanner);
    const second = await scanner.scan(db, projectId);
    expect(second.stats).toMatchObject({ statOnly: FILES.length, hashed: 0 });
    expect(second.toIndex).toHaveLength(0);
    expect(second.unchanged).toHaveLength(FILES.length);
  });

  it('touch (mtime change, same content) re-hashes once, then goes back to stat-only', async () => {
    const scanner = new FileScanner(root);
    await scanAndPersist(scanner);
    const future = new Date(Date.now() + 5_000);
    utimesSync(join(root, 'a.ts'), future, future);

    const third = await scanner.scan(db, projectId);
    expect(third.stats).toMatchObject({ statOnly: FILES.length - 1, hashed: 1 });
    expect(third.toIndex).toHaveLength(0); // content identical → unchanged

    const fourth = await scanner.scan(db, projectId); // touchMtime stamped it
    expect(fourth.stats).toMatchObject({ statOnly: FILES.length, hashed: 0 });
  });

  it('a real edit lands in toIndex with the fresh hash', async () => {
    const scanner = new FileScanner(root);
    await scanAndPersist(scanner);
    const newContent = 'export const a2 = "changed";\n';
    writeFileSync(join(root, 'a.ts'), newContent, 'utf-8');
    const future = new Date(Date.now() + 5_000);
    utimesSync(join(root, 'a.ts'), future, future);

    const res = await scanner.scan(db, projectId);
    expect(res.toIndex).toHaveLength(1);
    expect(res.toIndex[0].relativePath).toBe('a.ts');
    expect(res.toIndex[0].hash).toBe(hashContent(newContent));
    expect(res.toIndex[0].mtimeMs).toBe(Math.trunc(statSync(join(root, 'a.ts')).mtimeMs));
  });

  it('files over the size cap are skipped via stat, never read', async () => {
    writeFileSync(join(root, 'big.ts'), 'x'.repeat(2048), 'utf-8');
    const scanner = new FileScanner(root, [], 1); // cap = 1KB
    const res = await scanner.scan(db, projectId);
    expect(res.stats?.skippedTooLarge).toBe(1);
    expect(res.toIndex.some((f) => f.relativePath === 'big.ts')).toBe(false);
  });

  it('aborts early when the candidate file cap is exceeded', async () => {
    const scanner = new FileScanner(root);
    const res = await scanner.scan(db, projectId, { maxFiles: 2 });
    expect(res.aborted).toBe('too_large');
    expect(res.totalFiles).toBe(3);
    expect(res.toIndex).toHaveLength(0);
  });

  it('MCP_SCAN_PARANOID=1 forces hashing even when stat matches', async () => {
    const scanner = new FileScanner(root);
    await scanAndPersist(scanner);
    process.env.MCP_SCAN_PARANOID = '1';
    const res = await scanner.scan(db, projectId);
    expect(res.stats).toMatchObject({ statOnly: 0, hashed: FILES.length });
    expect(res.unchanged).toHaveLength(FILES.length);
  });

  it('deleted files land in toRemove', async () => {
    const scanner = new FileScanner(root);
    await scanAndPersist(scanner);
    rmSync(join(root, 'c.ts'));
    const res = await scanner.scan(db, projectId);
    expect(res.toRemove).toEqual(['c.ts']);
  });

  it('checks journaled edits of equal size and modification time', async () => {
    const file = join(root, 'a.ts');
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(file, stamp, stamp);
    await runStructuralIndex(db, projectId);
    const old = db.listFileScanMeta(projectId).find(entry => entry.path === 'a.ts')!;
    writeFileSync(file, "export const a = 'z.ts';\n");
    utimesSync(file, stamp, stamp);
    expect(statSync(file).size).toBe(old.size);
    expect(Math.trunc(statSync(file).mtimeMs)).toBe(old.mtime_ms);
    const result = await runStructuralIndex(db, projectId, { verifyPaths: ['a.ts'] });
    expect(result).toMatchObject({ indexed: 1, skipped: 2, errorCount: 0 });
    expect(db.getFile(projectId, 'a.ts')!.content_hash).not.toBe(old.content_hash);
  });

  it('retains the published revision and retries a watcher event when its root returns', async () => {
    const initial = await runStructuralIndex(db, projectId);
    expect(initial.indexed).toBe(FILES.length);
    const revision = db.getStructuralRevision(projectId);
    const checkedAt = db.getProject(projectId)?.structural_last_checked_at;
    const moved = join(dir, 'disconnected');
    renameSync(root, moved);
    const { createInProcessStructuralExecutor } = await import('@mcp/services/services/project-index/in-process-executor.js');
    const offline = await createInProcessStructuralExecutor(db).runStructuralIndex(projectId, {});
    expect(offline.unavailableRoots).toEqual([root]);
    expect(offline.removed).toBe(0);
    expect((await indexFilesStructural(db, projectId, ['a.ts'])).failedPaths).toEqual(['a.ts']);
    expect(db.getStructuralRevision(projectId)).toBe(revision);
    expect(db.getProject(projectId)?.structural_last_checked_at).toBe(checkedAt);
    expect(db.getFile(projectId, 'a.ts')).toBeDefined();
    renameSync(moved, root);
    rmSync(join(root, 'a.ts'));
    expect((await indexFilesStructural(db, projectId, ['a.ts'])).removed).toBe(1);
  });

  it('reconciles removed, offline, reconnected and explicitly detached roots independently', async () => {
    const offline = join(dir, 'offline');
    const linked = [{ name: 'Online', root_path: root }, { name: 'Offline', root_path: offline }];
    const catalog = {
      getProject: () => ({ is_synthetic: true }), listUnionProjectIds: () => linked,
      listFileScanMeta: () => ['online/gone.ts', 'offline/keep.ts'].map(path => ({ path })),
      getFileIndegrees: () => new Map(),
    } as unknown as CodeIndexDB;
    const scanner = new FileScanner(root);
    const partial = await scanner.scan(catalog, projectId);
    expect(partial.toRemove).toEqual(['online/gone.ts']);
    expect(partial.unavailableRoots).toEqual([offline]);
    mkdirSync(offline);
    writeFileSync(join(offline, 'keep.ts'), 'export const restored = true;');
    expect((await scanner.scan(catalog, projectId)).toRemove).toEqual(['online/gone.ts']);
    linked.pop();
    expect((await scanner.scan(catalog, projectId)).toRemove).toEqual(['online/gone.ts', 'offline/keep.ts']);
  });

});
