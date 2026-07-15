import { describe, expect, it } from 'vitest';
import {
  parsePackageManagers,
  readPackageManager,
  writePackageManager,
} from '../package-managers.js';

describe('package-managers', () => {
  it('parses a well-formed JSON map', () => {
    expect(parsePackageManagers('{"node":"pnpm","python":"poetry","java":"maven"}')).toEqual({
      node: 'pnpm',
      python: 'poetry',
      java: 'maven',
    });
  });

  it('is tolerant of null / corrupt / wrong-shape input', () => {
    expect(parsePackageManagers(null)).toEqual({});
    expect(parsePackageManagers(undefined)).toEqual({});
    expect(parsePackageManagers('')).toEqual({});
    expect(parsePackageManagers('not json')).toEqual({});
    expect(parsePackageManagers('[1,2,3]')).toEqual({});
    expect(parsePackageManagers('{"node":123}')).toEqual({}); // non-string dropped
  });

  it('reads a single key', () => {
    const json = '{"node":"yarn"}';
    expect(readPackageManager(json, 'node')).toBe('yarn');
    expect(readPackageManager(json, 'python')).toBeUndefined();
  });

  it('writes a key while preserving the other', () => {
    const json = writePackageManager('{"python":"pip"}', 'node', 'bun');
    expect(parsePackageManagers(json)).toEqual({ python: 'pip', node: 'bun' });
  });

  it('removes a key when the id is empty / null / auto (back to detection)', () => {
    const base = '{"node":"pnpm","python":"poetry"}';
    expect(parsePackageManagers(writePackageManager(base, 'node', null))).toEqual({ python: 'poetry' });
    expect(parsePackageManagers(writePackageManager(base, 'node', ''))).toEqual({ python: 'poetry' });
    expect(parsePackageManagers(writePackageManager(base, 'node', 'auto'))).toEqual({ python: 'poetry' });
  });

  it('round-trips through write → parse', () => {
    let json: string | null = null;
    json = writePackageManager(json, 'node', 'pnpm');
    json = writePackageManager(json, 'python', 'poetry');
    expect(parsePackageManagers(json)).toEqual({ node: 'pnpm', python: 'poetry' });
  });
});
