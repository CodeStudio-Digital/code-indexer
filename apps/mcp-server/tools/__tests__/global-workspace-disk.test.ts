import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDirectoryFromDisk } from '../file.js';
import { scanDiskForGrep } from '../search.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('global workspace disk fallbacks', () => {
  it('walks only authorized top-level links for directory fallback', () => {
    const base = mkdtempSync(join(tmpdir(), 'mcp-global-disk-'));
    roots.push(base);
    const union = join(base, 'union');
    const target = join(base, 'intranet');
    mkdirSync(union);
    mkdirSync(join(target, 'src'), { recursive: true });
    writeFileSync(join(target, 'src', 'screen.ts'), 'export const screen = true;');
    symlinkSync(target, join(union, 'poa-intranet-angular'), 'junction');
    const unlinked = join(base, 'unlinked');
    mkdirSync(unlinked);
    writeFileSync(join(unlinked, 'secret.ts'), 'do not traverse');
    symlinkSync(unlinked, join(union, 'not-in-database'), 'junction');

    const entries = listDirectoryFromDisk(
      union,
      '',
      2,
      new Set(['poa-intranet-angular']),
    );

    expect(entries).toContain('poa-intranet-angular/');
    expect(entries).toContain('poa-intranet-angular/src/screen.ts (27B)');
    expect(listDirectoryFromDisk(
      union,
      'poa-intranet-angular/src',
      1,
      new Set(['poa-intranet-angular']),
    )).toContain('poa-intranet-angular/src/screen.ts (27B)');
    expect(entries.some((entry) => entry.includes('not-in-database'))).toBe(false);
    expect(listDirectoryFromDisk(
      union,
      'not-in-database',
      2,
      new Set(['poa-intranet-angular']),
    )).toEqual([]);
  });

  it('scans authorized real roots and returns virtual slug-prefixed paths', async () => {
    const base = mkdtempSync(join(tmpdir(), 'mcp-global-grep-'));
    roots.push(base);
    const target = join(base, 'intranet');
    mkdirSync(join(target, 'src'), { recursive: true });
    writeFileSync(join(target, 'src', 'screen.ts'), 'export const screen = true;');

    const files = await scanDiskForGrep(join(base, 'union'), '**/*.ts', [
      { rootPath: join(base, 'missing'), prefix: 'missing-project' },
      { rootPath: target, prefix: 'poa-intranet-angular' },
    ]);

    expect(files).toEqual(['poa-intranet-angular/src/screen.ts']);
  });
});
