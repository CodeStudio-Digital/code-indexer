import { describe, expect, it } from 'vitest';
import { matchSnapshotPath } from '../snapshot-path-match.js';

/** Snapshot keys are always project-relative POSIX paths (recording port). */
function mapOf(...keys: string[]): Map<string, { id: string }> {
  return new Map(keys.map((k) => [k, { id: k }]));
}

describe('matchSnapshotPath', () => {
  it('resolves the already-working case: exact project-relative POSIX key', () => {
    const files = mapOf('scripts/cluster-cli.mjs', 'src/app.ts');
    const match = matchSnapshotPath(files, 'scripts/cluster-cli.mjs');

    expect(match.reason).toBe('exact');
    expect(match.file?.id).toBe('scripts/cluster-cli.mjs');
  });

  it('normalizes Windows separators on a relative path', () => {
    const files = mapOf('scripts/cluster-cli.mjs');
    const match = matchSnapshotPath(files, 'scripts\\cluster-cli.mjs');

    expect(match.reason).toBe('exact');
    expect(match.file?.id).toBe('scripts/cluster-cli.mjs');
  });

  it('falls back to a path suffix for an absolute Windows path', () => {
    const files = mapOf('scripts/cluster-cli.mjs', 'src/app.ts');
    const match = matchSnapshotPath(files, 'D:\\proj\\scripts\\cluster-cli.mjs');

    expect(match.reason).toBe('suffix');
    expect(match.file?.id).toBe('scripts/cluster-cli.mjs');
  });

  it('falls back to a path suffix for an absolute POSIX path', () => {
    const files = mapOf('scripts/cluster-cli.mjs');
    const match = matchSnapshotPath(files, '/home/me/proj/scripts/cluster-cli.mjs');

    expect(match.reason).toBe('suffix');
    expect(match.file?.id).toBe('scripts/cluster-cli.mjs');
  });

  it('ignores `./` and duplicated separators', () => {
    const files = mapOf('scripts/cluster-cli.mjs');
    const match = matchSnapshotPath(files, './scripts//cluster-cli.mjs');

    expect(match.file?.id).toBe('scripts/cluster-cli.mjs');
  });

  it('only matches on segment boundaries', () => {
    const files = mapOf('scripts/cluster-cli.mjs');

    // A longer basename must not match the shorter tracked one.
    expect(matchSnapshotPath(files, 'D:\\proj\\scripts\\outro-cluster-cli.mjs').reason).toBe('missing');
    // Nor a longer directory name.
    expect(matchSnapshotPath(files, 'D:\\proj\\my-scripts\\cluster-cli.mjs').reason).toBe('missing');
  });

  it('refuses to guess when more than one key matches the suffix', () => {
    const files = mapOf('cluster-cli.mjs', 'scripts/cluster-cli.mjs');
    const match = matchSnapshotPath(files, 'D:\\proj\\scripts\\cluster-cli.mjs');

    // Project root is unknown here, so either key could be the real file.
    expect(match.reason).toBe('ambiguous');
    expect(match.file).toBeUndefined();
  });

  it('still prefers an exact key over an ambiguous suffix set', () => {
    const files = mapOf('cluster-cli.mjs', 'scripts/cluster-cli.mjs');
    const match = matchSnapshotPath(files, 'scripts/cluster-cli.mjs');

    expect(match.reason).toBe('exact');
    expect(match.file?.id).toBe('scripts/cluster-cli.mjs');
  });

  it('reports `missing` for a file outside the project (never snapshotted)', () => {
    const files = mapOf('src/app.ts');
    const match = matchSnapshotPath(files, 'D:\\Claude\\scripts\\cluster-cli.mjs');

    expect(match.reason).toBe('missing');
    expect(match.file).toBeUndefined();
  });

  it('reports `missing` against an empty map', () => {
    expect(matchSnapshotPath(new Map(), 'src/app.ts').reason).toBe('missing');
  });

  it('does not match a query that is shorter than the key', () => {
    // A bare basename is too weak a signal to pick a nested file.
    expect(matchSnapshotPath(mapOf('scripts/cluster-cli.mjs'), 'cluster-cli.mjs').reason).toBe('missing');
  });
});
