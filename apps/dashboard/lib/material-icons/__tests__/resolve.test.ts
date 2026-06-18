/**
 * Pure resolution tests for the Material icon stem resolver (manifest only,
 * no glob/URL). Asserts the VSCode icon-theme precedence on the real
 * generated manifest.
 */
import { describe, it, expect } from 'vitest';
import { stemForFile, stemForFolder } from '../resolve.js';

describe('stemForFile', () => {
  it('resolves by extension', () => {
    expect(stemForFile('a/b/index.ts')).toBe('typescript');
    expect(stemForFile('Component.tsx')).toBe('react_ts');
    expect(stemForFile('script.php')).toBe('php');
  });

  it('special filenames win over the bare extension', () => {
    // package.json maps to its own icon, not the generic json one.
    expect(stemForFile('package.json')).not.toBe(stemForFile('data.json'));
  });

  it('prefers the longest chained extension', () => {
    // foo.test.ts → "test.ts" mapping exists in Material and differs from "ts".
    expect(stemForFile('foo.test.ts')).toBe('test-ts');
  });

  it('falls back to the default file stem for unknowns', () => {
    expect(stemForFile('mystery.zzzzz')).toBe('file');
    expect(stemForFile('noext')).toBe('file');
  });

  it('is case-insensitive', () => {
    expect(stemForFile('INDEX.TS')).toBe('typescript');
  });
});

describe('stemForFolder', () => {
  it('resolves special folders, collapsed and expanded', () => {
    expect(stemForFolder('src', false)).toBe('folder-src');
    expect(stemForFolder('src', true)).toBe('folder-src-open');
  });

  it('falls back to the default folder stem', () => {
    expect(stemForFolder('totally-unknown-folder', false)).toBe('folder');
    expect(stemForFolder('totally-unknown-folder', true)).toBe('folder-open');
  });
});
