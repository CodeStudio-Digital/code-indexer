/**
 * wsl-runtime-versions — per-project, per-distro runtime selection JSON. Proves
 * tolerant parsing, the distro+kind axis, and prune-on-clear.
 */
import { describe, expect, it } from 'vitest';
import {
  parseWslRuntimeVersions,
  readWslRuntimeVersion,
  writeWslRuntimeVersion,
} from '../wsl-runtime-versions.js';

describe('parseWslRuntimeVersions', () => {
  it('returns {} for empty / corrupt / wrong-shape input', () => {
    expect(parseWslRuntimeVersions(null)).toEqual({});
    expect(parseWslRuntimeVersions('')).toEqual({});
    expect(parseWslRuntimeVersions('not json')).toEqual({});
    expect(parseWslRuntimeVersions('[1,2]')).toEqual({});
    expect(parseWslRuntimeVersions('{"Ubuntu":"oops"}')).toEqual({});
  });

  it('keeps only known kinds with non-empty string values, pruning empty distros', () => {
    const json = JSON.stringify({
      Ubuntu: { node: 'managed:20.11.0', python: 'managed:3.12.3', java: 'managed:21.0.7', dotnet: 'managed:10.0.301', bogus: 1 },
      Debian: { node: '' },
    });
    expect(parseWslRuntimeVersions(json)).toEqual({
      Ubuntu: {
        node: 'managed:20.11.0',
        python: 'managed:3.12.3',
        java: 'managed:21.0.7',
        dotnet: 'managed:10.0.301',
      },
    });
  });
});

describe('readWslRuntimeVersion', () => {
  it('reads a distro+kind, undefined when absent', () => {
    const json = JSON.stringify({ Ubuntu: { node: 'managed:20.11.0' } });
    expect(readWslRuntimeVersion(json, 'Ubuntu', 'node')).toBe('managed:20.11.0');
    expect(readWslRuntimeVersion(json, 'Ubuntu', 'python')).toBeUndefined();
    expect(readWslRuntimeVersion(json, 'Debian', 'node')).toBeUndefined();
  });
});

describe('writeWslRuntimeVersion', () => {
  it('merges without clobbering other distros/kinds', () => {
    let json = writeWslRuntimeVersion(null, 'Ubuntu', 'node', 'managed:20.11.0');
    json = writeWslRuntimeVersion(json, 'Ubuntu', 'python', 'managed:3.12.3');
    json = writeWslRuntimeVersion(json, 'Debian', 'node', 'managed:18.20.0');
    expect(parseWslRuntimeVersions(json)).toEqual({
      Ubuntu: { node: 'managed:20.11.0', python: 'managed:3.12.3' },
      Debian: { node: 'managed:18.20.0' },
    });
  });

  it("'system'/null clears the kind and prunes a now-empty distro", () => {
    const start = JSON.stringify({ Ubuntu: { node: 'managed:20.11.0' } });
    expect(parseWslRuntimeVersions(writeWslRuntimeVersion(start, 'Ubuntu', 'node', 'system'))).toEqual({});
    expect(parseWslRuntimeVersions(writeWslRuntimeVersion(start, 'Ubuntu', 'node', null))).toEqual({});
  });

  it('clearing one kind keeps the sibling kind', () => {
    const start = JSON.stringify({ Ubuntu: { node: 'managed:20.11.0', python: 'managed:3.12.3' } });
    const next = writeWslRuntimeVersion(start, 'Ubuntu', 'node', null);
    expect(parseWslRuntimeVersions(next)).toEqual({ Ubuntu: { python: 'managed:3.12.3' } });
  });
});
