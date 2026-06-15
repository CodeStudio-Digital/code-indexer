/**
 * Stat-first scanner: unchanged files are proven by mtime+size with ZERO
 * reads; reads happen only when the stat gate can't decide. Uses a real
 * CodeIndexDB on tmpdir (requires the Node-ABI better-sqlite3 build).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { FileScanner } from '../scanner.js';
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
function persist(file: { relativePath: string; hash: string; sizeBytes: number; lineCount: number; mtimeMs?: number }): void {
  db.upsertFile(projectId, {
    path: file.relativePath, language: 'typescript', size: file.sizeBytes,
    lineCount: file.lineCount, contentHash: file.hash,
    summary: 's', concepts: [], dependencies: [], internalDeps: [], externalDeps: [],
    notes: [], complexity: 'low', mtimeMs: file.mtimeMs ?? null,
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
});
