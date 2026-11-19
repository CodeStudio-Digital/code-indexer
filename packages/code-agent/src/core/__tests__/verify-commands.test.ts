/**
 * Unit tests for `detectVerifyCommands` — the dynamic-suffix block that
 * hands the agent the project's REAL verify commands (B2-dyn).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectVerifyCommands } from '../verify-commands.js';

const dirs: string[] = [];
function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-cmds-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('detectVerifyCommands', () => {
  it('returns empty for a project with no package.json / Makefile / justfile', () => {
    expect(detectVerifyCommands(tempProject())).toBe('');
  });

  it('lists verify-ish scripts first and names the package manager from packageManager', () => {
    const dir = tempProject();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@9.0.0',
      scripts: { dev: 'vite', test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' },
    }));
    const block = detectVerifyCommands(dir);
    expect(block).toContain('# Known verify commands (detected)');
    expect(block).toContain('`pnpm run <script>`');
    expect(block).not.toContain('dev');
    expect(block).toContain('only for a code change or an explicit verification request');
  });

  it('falls back to the lockfile for the package manager', () => {
    const dir = tempProject();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    writeFileSync(join(dir, 'yarn.lock'), '');
    expect(detectVerifyCommands(dir)).toContain('`yarn run <script>`');
  });

  it('caps the script list at 10 entries', () => {
    const dir = tempProject();
    const scripts: Record<string, string> = {};
    for (let i = 0; i < 20; i++) scripts[`test:suite${i}`] = 'echo';
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
    const line = detectVerifyCommands(dir).split('\n').find((l) => l.startsWith('package.json'))!;
    expect(line.split(',').length).toBe(10);
  });

  it('does not suggest unrelated project commands for verification', () => {
    const dir = tempProject();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { deploy: 'release', start: 'serve' } }));
    expect(detectVerifyCommands(dir)).toBe('');
  });

  it('points at the Makefile when there is no package.json', () => {
    const dir = tempProject();
    writeFileSync(join(dir, 'Makefile'), 'test:\n\techo ok\n');
    const block = detectVerifyCommands(dir);
    expect(block).toContain('Makefile');
    expect(block).toContain('make <target>');
  });

  it('returns empty instead of throwing on malformed package.json', () => {
    const dir = tempProject();
    writeFileSync(join(dir, 'package.json'), '{not json');
    expect(detectVerifyCommands(dir)).toBe('');
  });

  it('reports installed Windows launchers without assuming an internal cli.js', () => {
    const dir = tempProject();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'xo && ava' } }));
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules/.bin/xo.cmd'), '@echo off');
    const block = detectVerifyCommands(dir, 'win32');
    expect(block).toContain('`node_modules/.bin/xo.cmd`');
    expect(block).not.toContain('`node_modules/.bin/ava.cmd`');
  });
});
