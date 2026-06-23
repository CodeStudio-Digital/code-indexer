import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { makeIgnored } from '../watcher.js';

/**
 * The chokidar `ignored` predicate must PRUNE heavy/generated/dependency dirs
 * (so chokidar never opens a native fs.watch per node_modules subdir — the
 * 145k-handle main-heap blowup), while leaving source dirs watched and NOT
 * matching dir names that only appear in the path PREFIX above the root.
 */
describe('makeIgnored', () => {
  const root = join('C:', 'projects', 'app');
  const ig = makeIgnored(root);
  const p = (...segs: string[]) => join(root, ...segs);

  it('prunes dependency / build / cache dirs anywhere below the root', () => {
    for (const d of [
      'node_modules', '.git', 'dist', 'build', 'out', '.next', '.angular',
      'target', 'vendor', 'bin', 'obj', '__pycache__', '.venv', '.gradle',
      'Pods', '.terraform', '.idea', '.mcp-indexer', '.turbo', '_build', 'deps',
    ]) {
      expect(ig(p(d))).toBe(true); // the dir itself
      expect(ig(p(d, 'deep', 'file.js'))).toBe(true); // anything under it
    }
    // nested anywhere (monorepo package's own node_modules)
    expect(ig(p('packages', 'web', 'node_modules', 'react', 'index.js'))).toBe(true);
  });

  it('keeps source dirs watched (incl. monorepo source roots)', () => {
    for (const d of ['src', 'lib', 'app', 'packages', 'apps', 'public', 'scripts', 'test', 'docs']) {
      expect(ig(p(d, 'index.ts'))).toBe(false);
    }
    expect(ig(p('packages', 'core', 'src', 'a.ts'))).toBe(false);
  });

  it('never ignores the watched root itself', () => {
    expect(ig(root)).toBe(false);
  });

  it('does NOT match dir names in the PREFIX above the root', () => {
    // Project living under a `temp` / `build` ancestor must be fully watched.
    const underTemp = makeIgnored(join('C:', 'temp', 'myapp'));
    expect(underTemp(join('C:', 'temp', 'myapp', 'src', 'a.ts'))).toBe(false);
    expect(underTemp(join('C:', 'temp', 'myapp', 'node_modules', 'x'))).toBe(true);

    const underBuild = makeIgnored(join('D:', 'build', 'svc'));
    expect(underBuild(join('D:', 'build', 'svc', 'lib', 'b.ts'))).toBe(false);
  });

  it('ignores paths outside the root (conservative: returns false)', () => {
    expect(ig(join('C:', 'projects', 'other', 'node_modules'))).toBe(false);
  });
});
