import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { listDirectory } from '../list-directory.js';
import { diskDirectoryPage } from '../directory-page.js';
import { projectReadPath, projectRelativePath } from '../project-read-path.js';
import type { IndexToolContext } from '../../context.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(fn => fn()); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'directory-page-')), projectRoot = join(root, 'project'); mkdirSync(projectRoot);
  const db = new CodeIndexDB(join(root, 'index.db')), project = db.createProject('directory-test', projectRoot);
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, project, projectRoot, ctx: { db } as IndexToolContext };
}
const text = (r: Awaited<ReturnType<typeof listDirectory.handler>>) => typeof r === 'string' ? r : r.text;

it('pages only directory metadata with separator-aware prefix and depth, preserving the full tail', async () => {
  const { db, project, ctx } = fixture();
  const add = (path: string) => db.upsertFile(project.id, { path, language: 'typescript', size: 1, lineCount: 1, contentHash: path });
  db.raw().transaction(() => { for (let i = 0; i < 553; i++) add(`src/file-${String(i).padStart(4, '0')}.ts`); add('src-old/private.ts'); add('src/deep/nested.ts'); })();
  vi.spyOn(db, 'listFiles').mockImplementation(() => { throw new Error('full hydration forbidden'); });
  const first = await listDirectory.handler({ project_name: project.name, path: 'src', depth: 0 }, ctx);
  expect(first).toMatchObject({ sourceTruncations: [{ inputSize: 553, outputSize: 500 }] });
  expect(text(first)).toContain('"offset":500'); expect(text(first)).not.toContain('nested'); expect(text(first)).not.toContain('private');
  const tail = text(await listDirectory.handler({ project_name: project.name, path: 'src/', depth: 0, offset: 500 }, ctx));
  expect(tail).toContain('file-0552.ts'); expect(tail).not.toContain('file-0499.ts');
  expect(db.listAgentDirectoryFiles(project.id, 'src', 1).total).toBe(554);
});

it('streams disk pages with one-item lookahead, releases the loop and recovers every file', async () => {
  const { projectRoot } = fixture();
  for (let i = 0; i < 553; i++) writeFileSync(join(projectRoot, `f-${String(i).padStart(4, '0')}.ts`), 'x');
  let ticks = 0; const timer = setInterval(() => ticks++, 1);
  try {
    const first = await diskDirectoryPage(projectRoot, '', 0, 0, 500);
    expect(first).toMatchObject({ total: 501, nextOffset: 500, totalExact: false });
    const last = await diskDirectoryPage(projectRoot, '', 0, 500, 500);
    expect(last).toMatchObject({ total: 553, totalExact: true }); expect(last.items).toHaveLength(53);
    expect(new Set([...first.items, ...last.items]).size).toBe(553); expect(ticks).toBeGreaterThan(0);
  } finally { clearInterval(timer); }
});

it('cannot escape via traversal, absolute prefixes, alternate streams or directory junctions', async () => {
  const { root, projectRoot } = fixture(); const outside = join(root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'secret.ts'), 'secret'); symlinkSync(outside, join(projectRoot, 'linked'), 'junction');
  for (const value of ['../outside', '..\\outside', 'file.ts:stream', '\\\\other-host\\share\\file.ts', outside]) expect(() => projectRelativePath(projectRoot, value)).toThrow('outside');
  await expect(projectReadPath(projectRoot, 'linked')).rejects.toThrow('outside');
  await expect(diskDirectoryPage(projectRoot, 'linked', 1, 0, 500)).rejects.toThrow('outside');
  expect((await diskDirectoryPage(projectRoot, '', 2, 0, 500)).items).toEqual([]);
});

it('closes active directory handles on cancellation and rejects invalid inputs before querying', async () => {
  const { projectRoot, ctx, project, db } = fixture();
  for (let i = 0; i < 100; i++) writeFileSync(join(projectRoot, `f-${i}.ts`), 'x');
  const ctrl = new AbortController(); const pending = diskDirectoryPage(projectRoot, '', 0, 0, 500, ctrl.signal);
  const rejected = expect(pending).rejects.toThrow('stopped'); setTimeout(() => ctrl.abort(new Error('stopped')), 1);
  await rejected; rmSync(projectRoot, { recursive: true }); mkdirSync(projectRoot);
  const query = vi.spyOn(db, 'listAgentDirectoryFiles');
  for (const args of [{ limit: 0 }, { depth: 21 }, { offset: -1 }, { path: '../x' }]) {
    await expect(listDirectory.handler({ project_name: project.name, ...args }, ctx)).rejects.toThrow();
  }
  expect(query).not.toHaveBeenCalled();
});

it('never falls back to disk for an out-of-range indexed page and can inspect a new disk directory', async () => {
  const { projectRoot, project, db, ctx } = fixture();
  db.upsertFile(project.id, { path: 'known.ts', language: 'typescript', size: 1, lineCount: 1, contentHash: 'x' });
  writeFileSync(join(projectRoot, 'unindexed.ts'), 'x'); mkdirSync(join(projectRoot, 'new'));
  writeFileSync(join(projectRoot, 'new', 'fresh.ts'), 'x');
  const past = text(await listDirectory.handler({ project_name: project.name, offset: 1 }, ctx));
  expect(past).toContain('Empty.'); expect(past).not.toContain('unindexed'); expect(past).toContain('"offset":0');
  expect(text(await listDirectory.handler({ project_name: project.name, path: 'new' }, ctx))).toContain('new/fresh.ts (1B)');
});
