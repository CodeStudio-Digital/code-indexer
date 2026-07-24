import { existsSync, realpathSync, statSync } from 'node:fs';
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

export interface ExternalFilesystemRoot {
  id: number;
  rootPath: string;
  access: 'read' | 'write';
}

export function canonicalizeExternalRoot(rawPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (!rawPath.trim()) return { ok: false, reason: 'path cannot be empty' };
  const p = pathNative;
  if (!p.isAbsolute(rawPath)) return { ok: false, reason: 'path must be an absolute directory' };
  try {
    const canonical = realpathSync(p.resolve(rawPath));
    if (!statSync(canonical).isDirectory()) return { ok: false, reason: 'path must reference a directory' };
    if (canonical === p.parse(canonical).root) {
      return { ok: false, reason: 'refusing to authorize a filesystem root' };
    }
    return { ok: true, path: canonical };
  } catch (error) {
    return {
      ok: false,
      reason: `directory is not accessible: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type AuthorizedPathResult =
  | {
      ok: true;
      abs: string;
      rootPath: string;
      relativePath: string;
      external: boolean;
      access: 'read' | 'write';
      rootId?: number;
    }
  | { ok: false; reason: string };

/**
 * Resolve a native-tool path against the project or an explicitly authorized
 * external root/exact file reference. Relative paths always stay
 * project-relative. External paths require absolute paths so two folders with
 * the same child layout can never be confused.
 *
 * Existing symlinks/junctions are canonicalized before the containment check.
 * For a create path, the nearest existing ancestor is canonicalized and the
 * missing suffix is appended, preventing a granted folder's symlink from
 * escaping into an unrelated host directory.
 */
export function resolveAuthorizedPath(
  inputPath: string,
  projectRoot: string,
  externalRoots: readonly ExternalFilesystemRoot[] | undefined,
  intent: 'read' | 'write',
): AuthorizedPathResult {
  const projectPaths = pathFor(projectRoot);
  if (!projectPaths.isAbsolute(inputPath)) {
    const abs = resolveSafe(inputPath, projectRoot);
    if (!abs) return { ok: false, reason: `Path '${inputPath}' is outside project root` };
    return {
      ok: true,
      abs,
      rootPath: projectRoot,
      relativePath: projectPaths.relative(projectRoot, abs).replace(/\\/g, '/') || '.',
      external: false,
      access: 'write',
    };
  }

  const projectAbs = resolveSafe(inputPath, projectRoot);
  if (projectAbs) {
    return {
      ok: true,
      abs: projectAbs,
      rootPath: projectRoot,
      relativePath: projectPaths.relative(projectRoot, projectAbs).replace(/\\/g, '/') || '.',
      external: false,
      access: 'write',
    };
  }

  const candidates = [...(externalRoots ?? [])].sort((a, b) => b.rootPath.length - a.rootPath.length);
  for (const root of candidates) {
    const lexical = resolveSafe(inputPath, root.rootPath);
    if (!lexical) continue;
    const canonical = canonicalizeCandidate(lexical, root.rootPath);
    if (!canonical) {
      return { ok: false, reason: `Path '${inputPath}' escapes authorized root through a symlink or junction` };
    }
    if (intent === 'write' && root.access !== 'write') {
      return { ok: false, reason: `Path '${inputPath}' is under a read-only authorized root` };
    }
    const p = pathFor(root.rootPath);
    return {
      ok: true,
      abs: canonical,
      rootPath: root.rootPath,
      relativePath: p.relative(root.rootPath, canonical).replace(/\\/g, '/') || '.',
      external: true,
      access: root.access,
      rootId: root.id,
    };
  }

  const roots = candidates.map((root) => `${root.rootPath} (${root.access})`).join(', ');
  return {
    ok: false,
    reason: roots
      ? `Path '${inputPath}' is outside the project and authorized roots: ${roots}`
      : `Path '${inputPath}' is outside project root`,
  };
}

function canonicalizeCandidate(candidate: string, canonicalRoot: string): string | null {
  const p = pathFor(canonicalRoot);
  let existing = candidate;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = p.dirname(existing);
    if (parent === existing) return null;
    missing.unshift(p.basename(existing));
    existing = parent;
  }
  let canonicalExisting: string;
  try {
    canonicalExisting = realpathSync(existing);
  } catch {
    return null;
  }
  const canonicalCandidate = p.resolve(canonicalExisting, ...missing);
  return resolveSafe(canonicalCandidate, canonicalRoot);
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
