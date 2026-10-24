/**
 * Matches an edit tool's raw `path` argument against the snapshot map's keys.
 *
 * Snapshots are keyed by project-relative POSIX path — the recording port stores
 * `relPath.replace(/\\/g, '/')` — but a tool call carries whatever the agent
 * typed, frequently an absolute Windows path (`D:\proj\scripts\cli.mjs`). An
 * exact-key lookup misses those, so the row rendered a permanent `–` with no
 * expandable diff even though the baseline existed.
 *
 * Resolution order: exact key → separator-normalized key → unique path suffix.
 * The suffix pass matches whole segments only (`scripts/cli.mjs` never matches
 * `other-cli.mjs`) and refuses to guess when more than one key matches: the
 * project root is unknown on this side, so `cli.mjs` and `scripts/cli.mjs` are
 * genuinely indistinguishable and the wrong file's diff is worse than none.
 */

type SnapshotPathMatch<T> =
  /** Resolved: `exact` hit a key as-is, `suffix` matched a project-relative tail. */
  | { file: T; reason: 'exact' | 'suffix' }
  /** Unresolved: nothing matched, or several keys did and we refuse to guess. */
  | { file: undefined; reason: 'missing' | 'ambiguous' };

/** Split on either separator, dropping empty and `.` segments. */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]+/).filter((seg) => seg !== '' && seg !== '.');
}

/** True when `keySegs` is a whole-segment tail of `querySegs`. */
function isSegmentSuffix(querySegs: string[], keySegs: string[]): boolean {
  if (keySegs.length === 0 || keySegs.length > querySegs.length) return false;
  const offset = querySegs.length - keySegs.length;
  return keySegs.every((seg, i) => querySegs[offset + i] === seg);
}

export function matchSnapshotPath<T>(
  files: ReadonlyMap<string, T>,
  path: string,
): SnapshotPathMatch<T> {
  // Keep the already-working case byte-identical: a project-relative POSIX path
  // resolves before any normalization runs.
  const exact = files.get(path);
  if (exact !== undefined) return { file: exact, reason: 'exact' };

  const querySegs = segmentsOf(path);
  const normalized = querySegs.join('/');
  if (normalized !== path) {
    const hit = files.get(normalized);
    if (hit !== undefined) return { file: hit, reason: 'exact' };
  }

  let found: T | undefined;
  for (const [key, file] of files) {
    if (!isSegmentSuffix(querySegs, segmentsOf(key))) continue;
    if (found !== undefined) return { file: undefined, reason: 'ambiguous' };
    found = file;
  }
  return found !== undefined
    ? { file: found, reason: 'suffix' }
    : { file: undefined, reason: 'missing' };
}
