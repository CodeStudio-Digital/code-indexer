import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildGlobalWorkspace,
  cleanupGlobalWorkspace,
  workspaceSlug,
} from '@mcp/code-agent/core/virtual-workspace.js';

/**
 * Validates the junction/symlink mechanism on the real OS AND — critically —
 * that cleanup NEVER deletes the linked projects' real files. No sqlite here,
 * so this runs without `pnpm node:rebuild`.
 */
describe('virtual-workspace (global union via junctions/symlinks)', () => {
  let root: string;
  let targetA: string;
  let targetB: string;
  let unionDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vws-'));
    targetA = join(root, 'real-backend');
    targetB = join(root, 'real-intranet');
    mkdirSync(join(targetA, 'src'), { recursive: true });
    mkdirSync(join(targetB, 'src'), { recursive: true });
    writeFileSync(join(targetA, 'src', 'keep-a.ts'), 'export const A = 1;');
    writeFileSync(join(targetB, 'src', 'keep-b.ts'), 'export const B = 2;');
    unionDir = join(root, 'union');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('slugifies project names deterministically and safely', () => {
    expect(workspaceSlug('poa-backend')).toBe('poa-backend');
    expect(workspaceSlug('My Project!')).toBe('my_project_');
  });

  it('links projects so files are readable THROUGH the union', () => {
    const links = buildGlobalWorkspace(unionDir, [
      { name: 'poa-backend', rootPath: targetA },
      { name: 'poa-intranet-angular', rootPath: targetB },
    ]);
    expect(links.map((l) => l.slug).sort()).toEqual(['poa-backend', 'poa-intranet-angular']);

    // Read a real file through the union link.
    const viaUnion = readFileSync(join(unionDir, 'poa-backend', 'src', 'keep-a.ts'), 'utf8');
    expect(viaUnion).toBe('export const A = 1;');

    // The union lists the project folders (so glob/indexer would descend).
    expect(readdirSync(unionDir).sort()).toEqual(['poa-backend', 'poa-intranet-angular']);
    expect(readdirSync(join(unionDir, 'poa-intranet-angular', 'src'))).toContain('keep-b.ts');
  });

  it('writes THROUGH the union land in the real project', () => {
    buildGlobalWorkspace(unionDir, [{ name: 'poa-backend', rootPath: targetA }]);
    writeFileSync(join(unionDir, 'poa-backend', 'src', 'new.ts'), 'export const N = 3;');
    // The write is visible in the REAL project directory.
    expect(existsSync(join(targetA, 'src', 'new.ts'))).toBe(true);
    expect(readFileSync(join(targetA, 'src', 'new.ts'), 'utf8')).toBe('export const N = 3;');
  });

  it('de-dups slugs when two projects slugify the same', () => {
    const links = buildGlobalWorkspace(unionDir, [
      { name: 'app', rootPath: targetA },
      { name: 'app!', rootPath: targetB },
    ]);
    expect(new Set(links.map((l) => l.slug)).size).toBe(2);
  });

  it('is idempotent — rebuilding keeps the same links', () => {
    buildGlobalWorkspace(unionDir, [{ name: 'poa-backend', rootPath: targetA }]);
    const again = buildGlobalWorkspace(unionDir, [{ name: 'poa-backend', rootPath: targetA }]);
    expect(again).toHaveLength(1);
    expect(readFileSync(join(unionDir, 'poa-backend', 'src', 'keep-a.ts'), 'utf8')).toBe('export const A = 1;');
  });

  it('SAFETY: cleanup removes the links but NEVER the real files', () => {
    buildGlobalWorkspace(unionDir, [
      { name: 'poa-backend', rootPath: targetA },
      { name: 'poa-intranet-angular', rootPath: targetB },
    ]);
    // Write something through the union first (so there's content created via the link).
    writeFileSync(join(unionDir, 'poa-backend', 'src', 'created.ts'), 'x');

    cleanupGlobalWorkspace(unionDir);

    // The union (and its links) are gone...
    expect(existsSync(unionDir)).toBe(false);
    // ...but EVERY real project file survives — the whole point.
    expect(existsSync(join(targetA, 'src', 'keep-a.ts'))).toBe(true);
    expect(existsSync(join(targetA, 'src', 'created.ts'))).toBe(true);
    expect(existsSync(join(targetB, 'src', 'keep-b.ts'))).toBe(true);
    expect(readFileSync(join(targetA, 'src', 'keep-a.ts'), 'utf8')).toBe('export const A = 1;');
  });

  it('SAFETY: cleanup refuses to delete a non-link entry left in the union dir', () => {
    buildGlobalWorkspace(unionDir, [{ name: 'poa-backend', rootPath: targetA }]);
    // A stray real file/dir inside the union dir must be left intact.
    writeFileSync(join(unionDir, 'stray.txt'), 'do not delete me');
    cleanupGlobalWorkspace(unionDir);
    expect(existsSync(join(unionDir, 'stray.txt'))).toBe(true); // refused → dir kept
    // And the real project is still intact.
    expect(existsSync(join(targetA, 'src', 'keep-a.ts'))).toBe(true);
  });
});
