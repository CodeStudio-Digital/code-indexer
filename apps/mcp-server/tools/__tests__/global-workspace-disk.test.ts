import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../context.js';
import { fileTools, listDirectoryFromDisk } from '../file.js';
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

  it('reports read_file line-window omission as structured metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-read-window-'));
    roots.push(root);
    writeFileSync(
      join(root, 'large.ts'),
      Array.from({ length: 1_001 }, (_, index) => `line ${index + 1}`).join('\n'),
    );
    const project = { id: 1, name: 'demo', root_path: root };
    const ctx = {
      db: {
        getProjectByName: () => project,
        getFile: () => null,
      },
    } as unknown as ToolContext;
    const readFile = fileTools.find((tool) => tool.name === 'read_file')!;

    const result = await readFile.handler({
      project_name: 'demo',
      file_path: 'large.ts',
      max_lines: 100,
    }, ctx);

    expect(typeof result).toBe('object');
    if (typeof result === 'string') throw new Error('Expected structured MCP tool result');
    expect(result.text).toContain('[lines 1-100]');
    expect(result.sourceTruncations).toEqual([{
      technique: 'mcp-read-file-line-window',
      inputSize: 1_001,
      outputSize: 100,
      unit: 'lines',
      recoverable: true,
    }]);
  });

  it('reports the bounded list_directory disk scan as a lower-bound omission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-list-cap-'));
    roots.push(root);
    for (let index = 0; index < 501; index++) {
      writeFileSync(join(root, `file-${String(index).padStart(3, '0')}.ts`), 'x');
    }
    const project = { id: 1, name: 'demo', root_path: root, is_synthetic: false };
    const ctx = {
      db: {
        getProjectByName: () => project,
        listFiles: () => [],
      },
    } as unknown as ToolContext;
    const listDirectory = fileTools.find((tool) => tool.name === 'list_directory')!;

    const result = await listDirectory.handler({ project_name: 'demo', depth: 1 }, ctx);

    expect(typeof result).toBe('object');
    if (typeof result === 'string') throw new Error('Expected structured MCP tool result');
    expect(result.text).toContain('disk scan capped at 500 entries');
    expect(result.sourceTruncations).toEqual([{
      technique: 'mcp-list-directory-disk-scan-cap',
      inputSize: 501,
      inputSizeExact: false,
      outputSize: 500,
      unit: 'items',
      recoverable: true,
    }]);
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
