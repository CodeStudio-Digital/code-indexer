import { describe, it, expect } from 'vitest';
import { foldPath, nextFreeName, planTransfer, remapRoot } from '../transfer-walk.js';
import type { FsAdapter, FsItem } from '../fs-adapter.js';

const f = (name: string, path: string, type: FsItem['type'] = 'file'): FsItem => ({
  name,
  path,
  type,
  size: type === 'file' ? 10 : 0,
  mtime: 0,
  mode: 0,
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

  // The walk lists a LEVEL at a time instead of one directory at a time: each
  // remote list is a full SFTP round-trip, so a wide tree used to spend one
  // sequential round-trip per directory before a single byte moved.
  describe('level-parallel walk', () => {
    /** Adapter that records concurrency and resolves asynchronously. */
    function timingAdapter(tree: Record<string, FsItem[]>) {
      let inFlight = 0;
      let peak = 0;
      const order: string[] = [];
      const adapter = {
        list: async (dir: string) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          order.push(dir);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return tree[dir] ?? [];
        },
      } as unknown as FsAdapter;
      return { adapter, peak: () => peak, order };
    }

    it('lists sibling directories concurrently', async () => {
      const tree: Record<string, FsItem[]> = {
        root: ['a', 'b', 'c', 'd'].map((n) => f(n, `root/${n}`, 'dir')),
        'root/a': [f('1', 'root/a/1')],
        'root/b': [f('2', 'root/b/2')],
        'root/c': [f('3', 'root/c/3')],
        'root/d': [f('4', 'root/d/4')],
      };
      const { adapter, peak } = timingAdapter(tree);
      const plan = await planTransfer([f('root', 'root', 'dir')], adapter);
      expect(peak()).toBeGreaterThan(1); // the four siblings overlapped
      expect(plan.files).toHaveLength(4);
    });

    it('still emits dirs parent-first, which remote mkdir depends on', async () => {
      const tree: Record<string, FsItem[]> = {
        root: [f('a', 'root/a', 'dir'), f('b', 'root/b', 'dir')],
        'root/a': [f('deep', 'root/a/deep', 'dir')],
        'root/a/deep': [f('x', 'root/a/deep/x')],
        'root/b': [],
      };
      const { adapter } = timingAdapter(tree);
      const plan = await planTransfer([f('root', 'root', 'dir')], adapter);
      // Every directory must appear after its own parent.
      for (const d of plan.dirs) {
        const parent = d.slice(0, d.lastIndexOf('/'));
        if (!parent) continue;
        expect(plan.dirs.indexOf(parent)).toBeLessThan(plan.dirs.indexOf(d));
      }
      expect(plan.dirs).toContain('root/a/deep');
    });

    it('still enforces the entry cap', async () => {
      const wide: Record<string, FsItem[]> = {
        root: Array.from({ length: 30_000 }, (_, i) => f(`f${i}`, `root/f${i}`)),
      };
      await expect(planTransfer([f('root', 'root', 'dir')], fakeAdapter(wide))).rejects.toThrow('too_many_files');
    });
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
