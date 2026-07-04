import { describe, it, expect } from 'vitest';
import { foldPath, nextFreeName, planTransfer, remapRoot } from '../transfer-walk.js';
import type { FsAdapter, FsItem } from '../fs-adapter.js';

const f = (name: string, path: string, type: FsItem['type'] = 'file'): FsItem => ({
  name,
  path,
  type,
  size: type === 'file' ? 10 : 0,
  mtime: 0,
});

/** Fake adapter — planTransfer only calls `list`. */
function fakeAdapter(tree: Record<string, FsItem[]>): FsAdapter {
  return { list: async (dir: string) => tree[dir] ?? [] } as unknown as FsAdapter;
}

describe('planTransfer', () => {
  it('lists top-level files with no dirs', async () => {
    const plan = await planTransfer([f('a.txt', 'a.txt'), f('b.txt', 'b.txt')], fakeAdapter({}));
    expect(plan.dirs).toEqual([]);
    expect(plan.files.map((x) => x.relPath)).toEqual(['a.txt', 'b.txt']);
  });

  it('recurses folders — dirs parent-first, files carry their rel path', async () => {
    const tree = {
      foo: [f('x', 'foo/x'), f('bar', 'foo/bar', 'dir')],
      'foo/bar': [f('y', 'foo/bar/y')],
    };
    const plan = await planTransfer([f('foo', 'foo', 'dir')], fakeAdapter(tree));
    expect(plan.dirs).toEqual(['foo', 'foo/bar']); // parent before child (so remote mkdir works in order)
    expect(plan.files.map((x) => x.relPath).sort()).toEqual(['foo/bar/y', 'foo/x']);
  });

  it('skips symlinks (loop guard)', async () => {
    const tree = { foo: [f('link', 'foo/link', 'symlink'), f('real', 'foo/real')] };
    const plan = await planTransfer([f('foo', 'foo', 'dir')], fakeAdapter(tree));
    expect(plan.files.map((x) => x.relPath)).toEqual(['foo/real']);
    expect(plan.dirs).toEqual(['foo']);
  });
});

describe('remapRoot', () => {
  it('rewrites the leading segment (keep both)', () => {
    const plan = { dirs: ['foo', 'foo/bar'], files: [{ srcPath: 's', relPath: 'foo/bar/y', size: 1 }] };
    const out = remapRoot(plan, 'foo', 'foo (1)');
    expect(out.dirs).toEqual(['foo (1)', 'foo (1)/bar']);
    expect(out.files[0].relPath).toBe('foo (1)/bar/y');
  });
});

describe('nextFreeName', () => {
  it('suffixes files keeping the extension', () => {
    expect(nextFreeName('a.txt', new Set(['a.txt']), true)).toBe('a (1).txt');
    expect(nextFreeName('a.txt', new Set(['a.txt', 'a (1).txt']), true)).toBe('a (2).txt');
  });
  it('suffixes dirs without an extension', () => {
    expect(nextFreeName('d', new Set(['d']), false)).toBe('d (1)');
  });
});

describe('foldPath', () => {
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
  it('folds a rel path onto a base', () => {
    expect(foldPath(join, '/base', 'a/b')).toBe('/base/a/b');
    expect(foldPath(join, '', 'a')).toBe('a');
    expect(foldPath(join, '/base', '')).toBe('/base');
  });
});
