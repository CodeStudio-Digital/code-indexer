import { existsSync } from 'node:fs';
import * as pathNative from 'node:path';
import { posix as pathPosix } from 'node:path';

/**
 * Heuristic: is `cwd` a POSIX-style absolute path?
 *
 * On a Windows host running the coder against a local project, `cwd` is
 * something like `D:\projects\foo` and native `node:path` (win32) is the
 * right module. But when the session is in builder mode, `cwd` points at
 * the sandbox container's workdir (`/app`) — a POSIX path. Using win32
 * `resolve('/app', 'src/App.tsx')` returns `C:\app\src\App.tsx`, which is
 * then handed to `podman cp container:...` and fails (the colon after
 * `C` confuses cp's arg parser, AND the path is wrong anyway).
 *
 * Rule: if the cwd starts with `/` and has no backslash, treat it as
 * POSIX and use `path.posix` for every resolve/relative/isAbsolute/
 * dirname call downstream. Anything else — Windows drive paths, UNC,
 * Linux-native — behaves exactly as before.
 */
function isPosixCwd(cwd: string): boolean {
  return cwd.startsWith('/') && !cwd.includes('\\');
}

/** Pick the right path module for a given `cwd` under the rule above. */
function pathFor(cwd: string): typeof pathNative {
  return isPosixCwd(cwd) ? (pathPosix as unknown as typeof pathNative) : pathNative;
}

/**
 * Resolve a project-relative path against the agent cwd and reject it if the
 * result escapes the project root. Returns the absolute path on success,
 * or null if the path is unsafe. Consolidates what used to be three near-
 * identical copies in fs.ts, glob.ts, and lsp.ts.
 */
export function resolveSafe(relPath: string, cwd: string): string | null {
  const p = pathFor(cwd);
  const abs = p.isAbsolute(relPath) ? relPath : p.resolve(cwd, relPath);
  const rel = p.relative(cwd, abs);
  if (rel.startsWith('..') || p.isAbsolute(rel)) return null;
  return abs;
}

/** Re-exported for tools that need to keep their own path arithmetic
 *  consistent with `resolveSafe`'s POSIX-vs-native decision. */
export { pathFor };

/**
 * Extended variant: also verifies the file exists on disk and returns the
 * forward-slash-normalized relative path alongside the absolute path. Used
 * by LSP tooling where both forms are needed immediately.
 */
export function resolveProjectFile(
  relPath: string,
  cwd: string,
): { abs: string; rel: string } | null {
  const abs = resolveSafe(relPath, cwd);
  if (!abs) return null;
  if (!existsSync(abs)) return null;
  const p = pathFor(cwd);
  const rel = p.relative(cwd, abs).split('\\').join('/');
  return { abs, rel };
}
