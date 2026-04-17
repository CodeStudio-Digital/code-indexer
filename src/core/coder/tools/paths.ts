import { existsSync } from 'node:fs';
import { resolve as pathResolve, relative, isAbsolute } from 'node:path';

/**
 * Resolve a project-relative path against the agent cwd and reject it if the
 * result escapes the project root. Returns the absolute path on success,
 * or null if the path is unsafe. Consolidates what used to be three near-
 * identical copies in fs.ts, glob.ts, and lsp.ts.
 */
export function resolveSafe(relPath: string, cwd: string): string | null {
  const abs = isAbsolute(relPath) ? relPath : pathResolve(cwd, relPath);
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs;
}

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
  const rel = relative(cwd, abs).split('\\').join('/');
  return { abs, rel };
}
