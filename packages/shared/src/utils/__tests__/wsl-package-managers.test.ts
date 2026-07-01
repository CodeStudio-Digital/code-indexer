/**
 * wsl-package-managers — per-project, per-distro package-manager selection JSON.
 * Proves tolerant parsing, the distro+kind axis, and prune-on-clear.
 */
import { describe, expect, it } from 'vitest';
import {
  parseWslPackageManagers,
  readWslPackageManager,
  writeWslPackageManager,
} from '../wsl-package-managers.js';

describe('parseWslPackageManagers', () => {
  it('returns {} for empty / corrupt / wrong-shape input', () => {
    expect(parseWslPackageManagers(null)).toEqual({});
    expect(parseWslPackageManagers('nope')).toEqual({});
    expect(parseWslPackageManagers('{"Ubuntu":"x"}')).toEqual({});
  });

  it('keeps only node/python string values, pruning empty distros', () => {
    const json = JSON.stringify({ Ubuntu: { node: 'npm', python: 'pip', php: 'composer' }, Debian: { node: '' } });
    expect(parseWslPackageManagers(json)).toEqual({ Ubuntu: { node: 'npm', python: 'pip' } });
  });
});

describe('read/writeWslPackageManager', () => {
  it('reads a distro+kind, undefined when absent', () => {
    const json = JSON.stringify({ Ubuntu: { node: 'pnpm' } });
    expect(readWslPackageManager(json, 'Ubuntu', 'node')).toBe('pnpm');
    expect(readWslPackageManager(json, 'Ubuntu', 'python')).toBeUndefined();
    expect(readWslPackageManager(json, 'Debian', 'node')).toBeUndefined();
  });

  it('merges without clobbering other distros/kinds', () => {
    let json = writeWslPackageManager(null, 'Ubuntu', 'node', 'npm');
    json = writeWslPackageManager(json, 'Ubuntu', 'python', 'pip');
    json = writeWslPackageManager(json, 'Debian', 'node', 'yarn');
    expect(parseWslPackageManagers(json)).toEqual({
      Ubuntu: { node: 'npm', python: 'pip' },
      Debian: { node: 'yarn' },
    });
  });

  it("'auto'/null clears the kind and prunes a now-empty distro", () => {
    const start = JSON.stringify({ Ubuntu: { node: 'npm' } });
    expect(parseWslPackageManagers(writeWslPackageManager(start, 'Ubuntu', 'node', 'auto'))).toEqual({});
    expect(parseWslPackageManagers(writeWslPackageManager(start, 'Ubuntu', 'node', null))).toEqual({});
  });
});
