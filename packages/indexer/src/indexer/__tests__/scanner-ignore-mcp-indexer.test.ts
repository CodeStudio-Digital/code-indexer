/**
 * Regression: the indexer's own private working dir (`.mcp-indexer/`, which
 * holds the trash bin + `.tmp` scratch files) must be ignored by the scanner.
 * Without this, the doc-indexer's `.mcp-indexer/trash/<ts>/.tmp/*.cjs` files
 * get indexed and fed to the LSP, which then loops on "Could not find source
 * file" once they're deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScannerIgnore, GLOB_PRUNE_DIRS } from '../scanner-ignore.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scan-ignore-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('scanner ignore — .mcp-indexer', () => {
  it('ignores trash + .tmp scratch files under .mcp-indexer', () => {
    const ig = buildScannerIgnore(root, [], () => false);
    expect(ig.ignores('.mcp-indexer/trash/2026-06-02T0/.tmp/asaas-docs-extract.cjs')).toBe(true);
    expect(ig.ignores('.mcp-indexer/cache/foo.json')).toBe(true);
    // Real source is still scanned.
    expect(ig.ignores('src/index.ts')).toBe(false);
  });

  it('hard-prunes the .mcp-indexer directory in the glob walk', () => {
    expect(GLOB_PRUNE_DIRS).toContain('.mcp-indexer');
  });
});

describe('scanner ignore — Java/.NET/Unity profiles', () => {
  it('drops Unity caches, generated IDE files, metadata and binary assets', () => {
    mkdirSync(join(root, 'Assets'), { recursive: true });
    mkdirSync(join(root, 'ProjectSettings'), { recursive: true });
    writeFileSync(join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0');
    const ig = buildScannerIgnore(root, [], () => false);

    for (const path of [
      'Library/PackageCache/pkg/file.cs', 'obj/Debug/generated.cs',
      'Assembly-CSharp.csproj', 'Assets/Player.prefab.meta', 'Assets/model.fbx',
      'Assets/source.psd',
    ]) expect(ig.ignores(path)).toBe(true);

    for (const path of [
      'Assets/Scripts/Player.cs', 'Assets/Player.prefab', 'Assets/Main.unity',
      'Packages/manifest.json', 'ProjectSettings/TagManager.asset',
    ]) expect(ig.ignores(path)).toBe(false);
  });

  it('keeps .NET project files but drops their scoped build output', () => {
    mkdirSync(join(root, 'services', 'App'), { recursive: true });
    writeFileSync(join(root, 'services', 'App', 'App.csproj'), '<Project/>');
    const ig = buildScannerIgnore(root, [], () => false);

    expect(ig.ignores('services/App/App.csproj')).toBe(false);
    expect(ig.ignores('services/App/Program.cs')).toBe(false);
    expect(ig.ignores('services/App/bin/Debug/App.dll')).toBe(true);
    expect(ig.ignores('services/App/obj/project.assets.json')).toBe(true);
    expect(ig.ignores('bin/repo-tool.sh')).toBe(false);
  });
});
