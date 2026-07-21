import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeIgnored, countWatchedEntries } from '../watcher.js';

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

      // The directory-monitor sync marker churns in every watched folder — prune
      // it wherever it appears (Assets, ProjectSettings, …), never the real input.
      for (const rel of [
        'Assets/Art/~UnityDirMonSyncFile~9c1f2', 'ProjectSettings/~UnityDirMonSyncFile~ab',
      ]) expect(unityIg(join(unityRoot, ...rel.split('/')))).toBe(true);
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

/**
 * The watch budget skips live per-file watching for pathologically large trees
 * (Unity Asset-Store imports, vendored monorepos) so chokidar never opens a
 * handle per subdir + re-reads whole directories on churn. The probe honors the
 * ignore predicate and must short-circuit past the cap instead of walking fully.
 */
describe('countWatchedEntries', () => {
  it('counts watched files + dirs and prunes ignored subtrees', async () => {
    const root = mkdtempSync(join(tmpdir(), 'watcher-count-'));
    try {
      mkdirSync(join(root, 'src', 'a'), { recursive: true });
      mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(root, 'src', 'a', 'x.ts'), '');
      writeFileSync(join(root, 'src', 'y.ts'), '');
      writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), ''); // pruned subtree
      const ig = makeIgnored(root);
      // watched: src/, src/a/, src/a/x.ts, src/y.ts = 4 (node_modules never descended).
      expect(await countWatchedEntries(root, ig, 1000)).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops probing once the cap is exceeded (no full walk)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'watcher-count-cap-'));
    try {
      for (let i = 0; i < 50; i++) writeFileSync(join(root, `f${i}.ts`), '');
      const ig = makeIgnored(root);
      // Over-budget verdict is all the caller needs; the probe returns early.
      expect(await countWatchedEntries(root, ig, 5)).toBeGreaterThan(5);
      expect(await countWatchedEntries(root, ig, 5)).toBeLessThanOrEqual(6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
