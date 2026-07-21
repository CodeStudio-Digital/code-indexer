import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolsForLanguage, resolveNodeToolBin, LINT_TOOLS } from '../tool-registry.js';

describe('toolsForLanguage', () => {
  it('routes languages to the right linters', () => {
    expect(toolsForLanguage('css').map((t) => t.id)).toEqual(['stylelint']);
    expect(toolsForLanguage('scss').map((t) => t.id)).toEqual(['stylelint']);
    expect(toolsForLanguage('typescript').map((t) => t.id)).toEqual(['eslint']);
    expect(toolsForLanguage('plaintext')).toEqual([]);
  });

  it('every spec builds the shared stdin+json invocation', () => {
    for (const t of LINT_TOOLS) {
      expect(t.args('src/a.ext')).toEqual(['--stdin', '--stdin-filename', 'src/a.ext', '-f', 'json']);
    }
  });
});

describe('resolveNodeToolBin', () => {
  const roots: string[] = [];
  const makeRoot = () => { const r = mkdtempSync(join(tmpdir(), 'mcp-lint-')); roots.push(r); return r; };
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  const stylelint = LINT_TOOLS.find((t) => t.id === 'stylelint')!;

  function installPkg(root: string, pkg: string, bin: unknown, binRel = 'bin/x.js'): void {
    const dir = join(root, 'node_modules', pkg);
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, bin }));
    writeFileSync(join(dir, binRel), '#!/usr/bin/env node\n');
  }

  it('resolves the bin path when installed (string bin)', () => {
    const root = makeRoot();
    installPkg(root, 'stylelint', 'bin/x.js');
    expect(resolveNodeToolBin(root, stylelint)).toBe(join(root, 'node_modules', 'stylelint', 'bin/x.js'));
  });

  it('resolves the bin path from an object bin keyed by tool id', () => {
    const root = makeRoot();
    installPkg(root, 'stylelint', { stylelint: 'bin/x.js', other: 'bin/other.js' });
    expect(resolveNodeToolBin(root, stylelint)).toBe(join(root, 'node_modules', 'stylelint', 'bin/x.js'));
  });

  it('returns null when the package is absent (detect-only: skip silently)', () => {
    expect(resolveNodeToolBin(makeRoot(), stylelint)).toBeNull();
  });

  it('returns null when the declared bin file is missing on disk', () => {
    const root = makeRoot();
    const dir = join(root, 'node_modules', 'stylelint');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'stylelint', bin: 'bin/missing.js' }));
    expect(resolveNodeToolBin(root, stylelint)).toBeNull();
  });
});
