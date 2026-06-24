/**
 * Pure path-reference helpers for the Explorer's "Copy reference" submenu.
 * No React / no Node `path` — the renderer can't import `node:path`, and we
 * must respect the project's NATIVE separator (a Windows `root_path` uses `\`,
 * a POSIX one `/`) while the tree's `entry.path` is always posix.
 *
 * `repoRoot` (from `git rev-parse --show-toplevel`) is posix-ish even on
 * Windows (`D:/repo`), whereas `root_path` is native (`D:\repo\app`) — so we
 * normalise both to posix for the prefix math and render back in the project's
 * native separator.
 */

/** The native separator a path uses (`\` if it contains one, else `/`). */
function sepOf(p: string): '\\' | '/' {
  return p.includes('\\') ? '\\' : '/';
}

/** Posix view of a native path: backslashes → slashes, trailing slashes trimmed. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Heuristic: a Windows path (drive letter or any backslash). Drives case-folding. */
function isWin(p: string): boolean {
  return p.includes('\\') || /^[A-Za-z]:/.test(p);
}

/**
 * Absolute, native-separator path of a tree entry:
 * `toNativeAbsolute('D:\\repo\\app', 'src/a.ts')` → `D:\repo\app\src\a.ts`.
 */
export function toNativeAbsolute(projectRoot: string, relPosix: string): string {
  const sep = sepOf(projectRoot);
  const root = projectRoot.replace(/[\\/]+$/, '');
  const rel = relPosix.replace(/^\/+/, '');
  if (!rel) return root;
  return `${root}${sep}${rel.split('/').join(sep)}`;
}

/**
 * Posix path of a tree entry relative to the git repo root, or `null` when the
 * project IS the repo root (then it equals the plain "Copy path") or the file
 * doesn't sit under `repoRoot` (defensive — never copy a wrong value).
 */
export function repoRelativePosix(
  repoRoot: string | null,
  projectRoot: string,
  relPosix: string,
): string | null {
  if (!repoRoot) return null;
  const repoP = toPosix(repoRoot);
  const projP = toPosix(projectRoot);
  const win = isWin(projectRoot) || isWin(repoRoot);
  const eq = win ? repoP.toLowerCase() === projP.toLowerCase() : repoP === projP;
  if (eq) return null; // project == repo root → "Copy path" already covers it
  const absP = `${projP}/${relPosix.replace(/^\/+/, '')}`;
  const prefix = `${repoP}/`;
  const under = win
    ? absP.toLowerCase().startsWith(prefix.toLowerCase())
    : absP.startsWith(prefix);
  if (!under) return null;
  return absP.slice(prefix.length);
}

/** Native-separator repo-relative path for display, or `null` (see above). */
export function toRepoRelative(
  repoRoot: string | null,
  projectRoot: string,
  relPosix: string,
): string | null {
  const posix = repoRelativePosix(repoRoot, projectRoot, relPosix);
  if (posix == null) return null;
  return sepOf(projectRoot) === '\\' ? posix.split('/').join('\\') : posix;
}

/**
 * Build a `github.com/.../blob/<branch>/<path>` URL from an origin remote, or
 * `null` when the remote isn't GitHub. Handles `git@`, `https://`, `ssh://`
 * forms with an optional `.git` suffix. Falls back to `HEAD` when no branch.
 */
export function githubUrlFor(
  remote: string,
  branch: string | null,
  repoRelPosix: string,
): string | null {
  const r = (remote ?? '').trim().replace(/\/+$/, '');
  if (!r) return null;
  const m =
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(r) ??
    /^(?:ssh:\/\/)?git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(r) ??
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(r);
  if (!m) return null;
  const org = m[1];
  const repo = m[2].replace(/\.git$/, '');
  const br = branch && branch.trim() ? branch.trim() : 'HEAD';
  const rel = repoRelPosix.replace(/^\/+/, '');
  return `https://github.com/${org}/${repo}/blob/${br}/${rel}`;
}
