import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleFs, scopePath } from '../fs.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cap-fs-'));
  writeFileSync(join(root, 'wrangler.toml'), 'name = "x"');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export {}');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('scopePath', () => {
  it('rejects traversal / absolute', () => {
    expect(() => scopePath(root, '../secret')).toThrow(/escapes/);
    expect(() => scopePath(root, '/etc/passwd')).toThrow(/escapes/);
  });
  it('canonicalizes an in-scope path', () => {
    expect(scopePath(root, './wrangler.toml')[1]).toBe('wrangler.toml');
  });
});

describe('handleFs', () => {
  const grants = { read: ['wrangler.toml', 'src/**'], write: ['wrangler.toml'] };

  it('reads a directly-granted file', async () => {
    expect(await handleFs('fs.readFile', { path: 'wrangler.toml' }, root, grants)).toContain('name');
  });

  it('reads a glob-granted path', async () => {
    expect(await handleFs('fs.readFile', { path: 'src/index.ts' }, root, grants)).toContain('export');
  });

  it('denies an ungranted read', async () => {
    await expect(
      handleFs('fs.readFile', { path: 'package.json' }, root, grants),
    ).rejects.toThrow(/permission_denied/);
  });

  it('denies a write without a write grant', async () => {
    await expect(
      handleFs('fs.writeFile', { path: 'src/index.ts', content: 'x' }, root, grants),
    ).rejects.toThrow(/permission_denied/);
  });

  it('allows a granted write and round-trips', async () => {
    await handleFs('fs.writeFile', { path: 'wrangler.toml', content: 'name="y"' }, root, grants);
    expect(await handleFs('fs.readFile', { path: 'wrangler.toml' }, root, grants)).toBe('name="y"');
  });

  it('denies traversal even with grants', async () => {
    await expect(handleFs('fs.readFile', { path: '../x' }, root, grants)).rejects.toThrow(/escapes/);
  });

  it('exists: true for present, false for granted-but-missing', async () => {
    expect(await handleFs('fs.exists', { path: 'wrangler.toml' }, root, grants)).toBe(true);
    expect(await handleFs('fs.exists', { path: 'src/missing.ts' }, root, grants)).toBe(false);
  });

  it('denies everything when no grants', async () => {
    await expect(handleFs('fs.readFile', { path: 'wrangler.toml' }, root, undefined)).rejects.toThrow(
      /permission_denied/,
    );
  });
});
