/**
 * Path-safety unit tests for the project-files routes. The resolver must
 * reject `..`, absolute paths (POSIX/drive-letter/UNC) and symlink escapes
 * — anything that would let the studio's files tab read outside the IDE
 * project root.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRealInsideRoot, isImageFile, resolveInsideRoot } from '../project-files.routes.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-files-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-files-outside-'));
  fs.mkdirSync(path.join(root, 'assets', 'sprites'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'hero.png'), 'png');
  fs.writeFileSync(path.join(outside, 'secret.png'), 'secret');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('resolveInsideRoot', () => {
  it('resolves plain and nested children under the root', () => {
    expect(resolveInsideRoot(root, 'assets')).toBe(path.resolve(root, 'assets'));
    expect(resolveInsideRoot(root, 'assets/sprites')).toBe(path.resolve(root, 'assets', 'sprites'));
    // Backslash separators are accepted and resolve to the same place.
    expect(resolveInsideRoot(root, 'assets\\sprites')).toBe(path.resolve(root, 'assets', 'sprites'));
  });

  it('rejects empty and whitespace-only input', () => {
    expect(() => resolveInsideRoot(root, '')).toThrow(/non-empty/);
    expect(() => resolveInsideRoot(root, '   ')).toThrow(/non-empty/);
  });

  it('rejects absolute paths in POSIX, drive-letter and UNC forms', () => {
    expect(() => resolveInsideRoot(root, '/etc/passwd')).toThrow(/Absolute/);
    expect(() => resolveInsideRoot(root, 'C:\\Windows\\system32')).toThrow(/Absolute/);
    expect(() => resolveInsideRoot(root, 'c:/Windows')).toThrow(/Absolute/);
    expect(() => resolveInsideRoot(root, '\\\\server\\share\\x')).toThrow(/Absolute/);
  });

  it('rejects any ".." segment, even when it would stay inside', () => {
    expect(() => resolveInsideRoot(root, '..')).toThrow(/traversal/);
    expect(() => resolveInsideRoot(root, '../sibling')).toThrow(/traversal/);
    expect(() => resolveInsideRoot(root, 'assets/../../escape')).toThrow(/traversal/);
    expect(() => resolveInsideRoot(root, 'assets\\..\\..\\escape')).toThrow(/traversal/);
    // Stays inside after resolution, but ".." segments are banned outright.
    expect(() => resolveInsideRoot(root, 'assets/../assets')).toThrow(/traversal/);
  });

  it('keeps names that merely contain dots', () => {
    expect(resolveInsideRoot(root, 'a..b/..c.png')).toBe(path.resolve(root, 'a..b', '..c.png'));
  });
});

describe('assertRealInsideRoot', () => {
  it('accepts real paths inside the root and returns the realpath', () => {
    const abs = path.join(root, 'assets', 'hero.png');
    expect(assertRealInsideRoot(root, abs)).toBe(fs.realpathSync(abs));
  });

  it('throws for paths that do not exist', () => {
    expect(() => assertRealInsideRoot(root, path.join(root, 'nope.png'))).toThrow();
  });

  it('rejects a symlink inside the root that points outside it', () => {
    const link = path.join(root, 'sneaky');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // symlink creation not permitted in this environment — skip
    }
    expect(() => assertRealInsideRoot(root, link)).toThrow(/escapes/);
    expect(() => assertRealInsideRoot(root, path.join(link, 'secret.png'))).toThrow(/escapes/);
  });
});

describe('isImageFile', () => {
  it('accepts the served image extensions case-insensitively', () => {
    for (const name of ['a.png', 'b.jpg', 'c.JPEG', 'd.gif', 'e.WebP']) {
      expect(isImageFile(name)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const name of ['a.txt', 'b.ts', 'c.svg', 'd.png.exe', 'noext', '.png-not-really']) {
      expect(isImageFile(name)).toBe(false);
    }
  });
});
