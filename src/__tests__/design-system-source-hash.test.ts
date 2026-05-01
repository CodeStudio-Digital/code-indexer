import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeSourceHash } from '../core/design-system/source-hash.js';

describe('computeSourceHash (design-system)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-ds-hash-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns the same hash for identical content', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;');
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2;');
    const h1 = await computeSourceHash(dir);
    const h2 = await computeSourceHash(dir);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a file changes', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;');
    const h1 = await computeSourceHash(dir);
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;');
    const h2 = await computeSourceHash(dir);
    expect(h1).not.toBe(h2);
  });

  it('changes when a file is added', async () => {
    writeFileSync(join(dir, 'a.ts'), 'x');
    const h1 = await computeSourceHash(dir);
    writeFileSync(join(dir, 'b.ts'), 'y');
    const h2 = await computeSourceHash(dir);
    expect(h1).not.toBe(h2);
  });

  it('ignores excluded directories by default', async () => {
    writeFileSync(join(dir, 'a.ts'), 'x');
    const h1 = await computeSourceHash(dir);

    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg.txt'), 'huge');
    mkdirSync(join(dir, 'storybook-static'), { recursive: true });
    writeFileSync(join(dir, 'storybook-static', 'index.html'), '<html>');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'compiled');

    const h2 = await computeSourceHash(dir);
    expect(h1).toBe(h2);
  });

  it('honors extra excludeDirs', async () => {
    writeFileSync(join(dir, 'a.ts'), 'x');
    mkdirSync(join(dir, 'tmp-cache'), { recursive: true });
    writeFileSync(join(dir, 'tmp-cache', 'data.bin'), 'noise');
    const without = await computeSourceHash(dir, { excludeDirs: ['tmp-cache'] });
    rmSync(join(dir, 'tmp-cache'), { recursive: true, force: true });
    const baseline = await computeSourceHash(dir);
    expect(without).toBe(baseline);
  });

  it('handles nested directories', async () => {
    mkdirSync(join(dir, 'src', 'components', 'Button'), { recursive: true });
    writeFileSync(join(dir, 'src', 'components', 'Button', 'Button.tsx'), 'JSX');
    const h1 = await computeSourceHash(dir);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
