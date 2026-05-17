import { readdirSync } from 'node:fs';

/**
 * Pure: validate that a workspace-relative path is safe for HTTP
 * callers to traverse. Rejects absolute paths, empty strings, and any
 * `..` segment that could climb out of the workdir. Normalises slashes.
 */
export function ensureSafeRelPath(relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('workspace path must be a non-empty string');
  }
  const normalised = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalised.startsWith('/')) {
    throw new Error('absolute paths are not allowed');
  }
  const parts = normalised.split('/');
  if (parts.some((p) => p === '..' || p === '.')) {
    throw new Error('relative path must not contain `..` or `.` segments');
  }
  if (normalised.includes('\0')) {
    throw new Error('path contains illegal NUL byte');
  }
  return parts.join('/');
}

/**
 * Prepend `base` to `relative` when `relative` is origin-less. Absolute
 * URLs pass through unchanged. Returns the original string verbatim
 * when no base is configured so managed envs degrade gracefully.
 */
export function absolutize(relative: string, base: string | null): string {
  if (!relative) return relative;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(relative)) return relative;
  if (!base) return relative;
  return relative.startsWith('/') ? `${base}${relative}` : `${base}/${relative}`;
}

/** True when `dir` exists and contains at least a `package.json`. */
export function hasInitializedWorkdir(dir: string): boolean {
  try {
    const entries = readdirSync(dir);
    return entries.includes('package.json');
  } catch {
    return false;
  }
}
