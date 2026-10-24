import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listDirFiltered,
  listFilesRecursive,
  searchFiles,
} from '@apps/http-api/server/routes/coder/project-files.js';

describe('coder project files over virtual workspace links', () => {
  let root: string;
  let targetA: string;
  let targetB: string;
  let unionDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'coder-project-files-'));
    targetA = join(root, 'real-backend');
    targetB = join(root, 'real-intranet');
    unionDir = join(root, 'union');
    mkdirSync(join(targetA, 'src'), { recursive: true });
    mkdirSync(join(targetB, 'src'), { recursive: true });
    writeFileSync(join(targetA, 'src', 'keep-a.ts'), 'export const A = 1;');
    writeFileSync(join(targetB, 'src', 'keep-b.ts'), 'export const B = 2;');
    mkdirSync(unionDir);
    symlinkSync(targetA, join(unionDir, 'poa-backend'), 'junction');
    symlinkSync(targetB, join(unionDir, 'poa-intranet-angular'), 'junction');
  });

  afterEach(() => {
    // Break only the junctions created by this fixture before walking its tree.
    for (const link of [join(targetA, 'src', 'back-to-union'), join(unionDir, 'poa-backend'), join(unionDir, 'poa-intranet-angular')]) {
      if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('lists linked projects as top-level folders and expands through them', async () => {
    const rootEntries = await listDirFiltered(unionDir, '.');
    expect(rootEntries.map((e) => ({ name: e.name, type: e.type }))).toEqual([
      { name: 'poa-backend', type: 'dir' },
      { name: 'poa-intranet-angular', type: 'dir' },
    ]);

    const srcEntries = await listDirFiltered(unionDir, 'poa-backend/src');
    expect(srcEntries).toContainEqual(
      expect.objectContaining({
        name: 'keep-a.ts',
        path: 'poa-backend/src/keep-a.ts',
        type: 'file',
      }),
    );
  });

  it('selects folders recursively through linked directories', async () => {
    const { files, truncated } = await listFilesRecursive(unionDir, 'poa-backend');
    expect(truncated).toBe(false);
    expect(files).toEqual(['poa-backend/src/keep-a.ts']);
    expect(existsSync(join(targetA, 'src', 'keep-a.ts'))).toBe(true);
  });

  it('searches through linked directories', async () => {
    const { results, truncated } = await searchFiles(unionDir, 'keep-b');
    expect(truncated).toBe(false);
    expect(results).toContainEqual({
      path: 'poa-intranet-angular/src/keep-b.ts',
      type: 'file',
    });
  });

  it('does not loop when a linked directory points back to the union', async () => {
    symlinkSync(unionDir, join(targetA, 'src', 'back-to-union'), 'junction');

    const { files, truncated } = await listFilesRecursive(unionDir, '.', {
      maxEntries: 100,
    });

    expect(truncated).toBe(false);
    expect(files.filter((p) => p.endsWith('keep-a.ts'))).toEqual([
      'poa-backend/src/keep-a.ts',
    ]);
    expect(files).toContain('poa-intranet-angular/src/keep-b.ts');
  });
});
