/**
 * Tiny semver comparator for the plugins panel's "update available" check.
 *
 * Copied verbatim from `packages/indexer/src/bootstrap/semver-compare.ts` —
 * that's a backend (`@mcp/indexer`) module the renderer never imports, and we
 * don't want to drag a Node-only package into the dashboard bundle just for
 * 14 lines. No ranges or pre-release ordering: just `>`, `<`, `==` between two
 * `M.m.p` strings (negative / zero / positive).
 */
function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parse(v: string): [number, number, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** True when `latest` is a strictly newer version than `installed`. */
export const updateAvailable = (installed: string, latest?: string): boolean =>
  !!latest && compareSemver(latest, installed) > 0;
