/**
 * Semver bump for the Design System Creator pipeline.
 *
 * Pure: takes the latest published semver + the requested bump kind and
 * returns the next version. Patch-only bumps that increment from
 * `null`/no-prior-version yield the initial `1.0.0`.
 *
 * Stays intentionally small — Verdaccio handles semver validation on
 * publish, so we never need fancy prerelease / build-metadata parsing.
 */

export type BumpKind = 'initial' | 'patch' | 'minor' | 'major';

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(s: string): { major: number; minor: number; patch: number } {
  const m = SEMVER_RE.exec(s);
  if (!m) throw new Error(`Invalid semver: '${s}' (expected M.m.p)`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatSemver(v: { major: number; minor: number; patch: number }): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Compute the next version. When `previous` is null the result is always
 * `1.0.0` regardless of the requested kind (we never create v0.x — the
 * package is "ready" the moment the master publishes the first build).
 */
export function bumpSemver(previous: string | null, kind: BumpKind): string {
  if (!previous || kind === 'initial') return '1.0.0';
  const v = parseSemver(previous);
  switch (kind) {
    case 'major': return formatSemver({ major: v.major + 1, minor: 0, patch: 0 });
    case 'minor': return formatSemver({ major: v.major, minor: v.minor + 1, patch: 0 });
    case 'patch': return formatSemver({ major: v.major, minor: v.minor, patch: v.patch + 1 });
  }
}

/**
 * Decide what bump_kind a new version represents based on the operator's
 * `next_bump_hint` (sticky on the session row) and whether this is the
 * first version. Pure — caller persists the result.
 */
export function resolveBumpKind(args: {
  previous: string | null;
  hint: 'patch' | 'minor' | 'major';
}): BumpKind {
  if (!args.previous) return 'initial';
  return args.hint;
}
