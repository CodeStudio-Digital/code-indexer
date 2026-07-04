import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  appendVersion,
  initProjectManifest,
  nextVersionNumber,
  readAssetManifest,
  readProjectManifest,
  writeAssetManifest,
  type SpriteAssetManifest,
} from '../manifest.js';
import { resolveInsideSpriteDir, spriteDir, spriteDirName, versionFileName } from '../paths.js';
import { slugify, uniqueSlug } from '../slug.js';

describe('slugify', () => {
  it('kebab-cases and ASCII-folds accents', () => {
    expect(slugify('Héllo Wörld!')).toBe('hello-world');
    expect(slugify('Goblin Chef #2')).toBe('goblin-chef-2');
  });

  it('collapses dashes and trims edges', () => {
    expect(slugify('--a___b--c--')).toBe('a-b-c');
  });

  it('falls back to "asset" when nothing usable remains', () => {
    expect(slugify('')).toBe('asset');
    expect(slugify('!!! ###')).toBe('asset');
  });

  it('caps at 48 chars without a trailing dash', () => {
    const slug = slugify(`${'a'.repeat(47)}-b-c`);
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('returns the base when free', () => {
    expect(uniqueSlug('goblin', () => false)).toBe('goblin');
  });

  it('appends -2, -3, ... on collision', () => {
    const taken = new Set(['goblin', 'goblin-2']);
    expect(uniqueSlug('goblin', (s) => taken.has(s))).toBe('goblin-3');
  });

  it('respects the 48-char cap when suffixing', () => {
    const base = 'a'.repeat(48);
    const result = uniqueSlug(base, (s) => s === base);
    expect(result.length).toBeLessThanOrEqual(48);
    expect(result.endsWith('-2')).toBe(true);
  });
});

describe('versionFileName', () => {
  it('formats v%03d', () => {
    expect(versionFileName(1)).toBe('v001.png');
    expect(versionFileName(42)).toBe('v042.png');
    expect(versionFileName(1234)).toBe('v1234.png');
  });

  it('rejects non-positive and fractional versions', () => {
    expect(() => versionFileName(0)).toThrow();
    expect(() => versionFileName(1.5)).toThrow();
  });
});

describe('resolveInsideSpriteDir', () => {
  const root = path.resolve('some-project');

  it('resolves relative paths under .sprite-studio', () => {
    const resolved = resolveInsideSpriteDir(root, 'assets/goblin/v001.png');
    expect(resolved).toBe(path.join(spriteDir(root), 'assets', 'goblin', 'v001.png'));
  });

  it('accepts backslash separators', () => {
    const resolved = resolveInsideSpriteDir(root, 'assets\\goblin\\v001.png');
    expect(resolved).toBe(path.join(spriteDir(root), 'assets', 'goblin', 'v001.png'));
  });

  it('rejects .. traversal in any form', () => {
    expect(() => resolveInsideSpriteDir(root, '../escape.png')).toThrow(spriteDirName);
    expect(() => resolveInsideSpriteDir(root, 'assets/../../escape.png')).toThrow(spriteDirName);
    expect(() => resolveInsideSpriteDir(root, '..\\escape.png')).toThrow(spriteDirName);
  });

  it('rejects absolute paths (posix, drive-letter, UNC)', () => {
    expect(() => resolveInsideSpriteDir(root, '/etc/passwd')).toThrow();
    expect(() => resolveInsideSpriteDir(root, 'C:\\evil\\x.png')).toThrow();
    expect(() => resolveInsideSpriteDir(root, '\\\\server\\share\\x.png')).toThrow();
  });

  it('rejects empty paths', () => {
    expect(() => resolveInsideSpriteDir(root, '')).toThrow();
    expect(() => resolveInsideSpriteDir(root, '   ')).toThrow();
  });
});

describe('manifests', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-studio-test-'));
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('initProjectManifest creates dirs and is idempotent', () => {
    const created = initProjectManifest(tmpRoot, 'My Game', { pixelPerfect: true });
    expect(created.schemaVersion).toBe(1);
    expect(fs.existsSync(path.join(spriteDir(tmpRoot), 'assets'))).toBe(true);
    expect(fs.existsSync(path.join(spriteDir(tmpRoot), 'refs'))).toBe(true);

    const again = initProjectManifest(tmpRoot, 'Other Name', {});
    expect(again.name).toBe('My Game'); // existing manifest wins
    expect(readProjectManifest(tmpRoot)?.name).toBe('My Game');
  });

  it('asset manifest roundtrip + appendVersion immutability', () => {
    const manifest: SpriteAssetManifest = {
      slug: 'goblin',
      displayName: 'Goblin',
      category: 'enemy',
      tags: ['green'],
      status: 'draft',
      versions: [],
    };
    writeAssetManifest(tmpRoot, 'goblin', manifest);
    expect(readAssetManifest(tmpRoot, 'goblin')?.displayName).toBe('Goblin');
    expect(nextVersionNumber(manifest)).toBe(1);

    const updated = appendVersion(tmpRoot, 'goblin', {
      v: 1,
      file: 'v001.png',
      source: 'generated',
      createdAt: new Date().toISOString(),
    });
    expect(updated.currentVersion).toBe(1);
    expect(updated.versions).toHaveLength(1);

    expect(() =>
      appendVersion(tmpRoot, 'goblin', {
        v: 1,
        file: 'v001.png',
        source: 'generated',
        createdAt: new Date().toISOString(),
      }),
    ).toThrow(/immutable/);
  });

  it('appendVersion rejects unknown slugs; missing manifests read as null', () => {
    expect(readAssetManifest(tmpRoot, 'nope')).toBeNull();
    expect(() =>
      appendVersion(tmpRoot, 'nope', {
        v: 1,
        file: 'v001.png',
        source: 'generated',
        createdAt: new Date().toISOString(),
      }),
    ).toThrow(/create the asset first/);
  });
});
