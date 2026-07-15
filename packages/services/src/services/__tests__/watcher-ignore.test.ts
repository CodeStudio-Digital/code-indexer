import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('prunes Unity caches/generated files without dropping project inputs', () => {
    const unityRoot = mkdtempSync(join(tmpdir(), 'watcher-unity-'));
    try {
      mkdirSync(join(unityRoot, 'Assets'), { recursive: true });
      mkdirSync(join(unityRoot, 'Packages'), { recursive: true });
      mkdirSync(join(unityRoot, 'ProjectSettings'), { recursive: true });
      writeFileSync(join(unityRoot, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0');
      const unityIg = makeIgnored(unityRoot);

      for (const rel of [
        'Library/PackageCache/pkg/file.cs', 'Temp/cache', 'Logs/Editor.log',
        'UserSettings/EditorUserSettings.asset', 'Assembly-CSharp.csproj',
        'Assets/Player.prefab.meta',
      ]) expect(unityIg(join(unityRoot, ...rel.split('/')))).toBe(true);

      for (const rel of [
        'Assets/Scripts/Player.cs', 'Assets/Main.unity', 'Packages/manifest.json',
        'ProjectSettings/TagManager.asset',
      ]) expect(unityIg(join(unityRoot, ...rel.split('/')))).toBe(false);
    } finally {
      rmSync(unityRoot, { recursive: true, force: true });
    }
  });

  it('keeps a non-Unity source directory named Library', () => {
    const ordinaryRoot = mkdtempSync(join(tmpdir(), 'watcher-library-'));
    try {
      const ordinaryIg = makeIgnored(ordinaryRoot);
      expect(ordinaryIg(join(ordinaryRoot, 'Library', 'domain', 'catalog.ts'))).toBe(false);
    } finally {
      rmSync(ordinaryRoot, { recursive: true, force: true });
    }
  });
});
