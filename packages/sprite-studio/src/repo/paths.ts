import path from 'node:path';

/** Name of the sprite-studio directory at the root of a game repo. */
export const spriteDirName = '.sprite-studio';

/** `<projectRoot>/.sprite-studio` (absolute). */
export function spriteDir(projectRoot: string): string {
  return path.resolve(projectRoot, spriteDirName);
}

/** `<projectRoot>/.sprite-studio/assets` (absolute). */
export function assetsRootDir(projectRoot: string): string {
  return path.join(spriteDir(projectRoot), 'assets');
}

/** `<projectRoot>/.sprite-studio/assets/<slug>` (absolute). */
export function assetDir(projectRoot: string, slug: string): string {
  return path.join(assetsRootDir(projectRoot), slug);
}

/** `<projectRoot>/.sprite-studio/refs` (absolute). */
export function refsDir(projectRoot: string): string {
  return path.join(spriteDir(projectRoot), 'refs');
}

/** `<projectRoot>/.sprite-studio/project.json` (absolute). */
export function projectManifestPath(projectRoot: string): string {
  return path.join(spriteDir(projectRoot), 'project.json');
}

/** `<projectRoot>/.sprite-studio/assets/<slug>/asset.json` (absolute). */
export function assetManifestPath(projectRoot: string, slug: string): string {
  return path.join(assetDir(projectRoot, slug), 'asset.json');
}

/** Immutable version file name: 1 -> `v001.png` (pads wider past 999). */
export function versionFileName(v: number): string {
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`Invalid sprite version number: ${v}`);
  }
  return `v${String(v).padStart(3, '0')}.png`;
}

function normalizeForCompare(p: string): string {
  // Windows paths are case-insensitive; compare case-folded there.
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolve `relPath` against `<projectRoot>/.sprite-studio/` and return the
 * absolute path. Every write into the sprite dir MUST go through this guard.
 *
 * Rejects (throws):
 * - empty input
 * - absolute paths (POSIX, drive-letter and UNC forms)
 * - any `..` segment
 * - anything that resolves outside `.sprite-studio/` (defense in depth)
 */
export function resolveInsideSpriteDir(projectRoot: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) {
    throw new Error(`Path inside ${spriteDirName} must be a non-empty relative path`);
  }
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new Error(`Absolute paths are not allowed inside ${spriteDirName}: ${relPath}`);
  }
  const segments = relPath.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new Error(`Path traversal ("..") is not allowed inside ${spriteDirName}: ${relPath}`);
  }
  const base = spriteDir(projectRoot);
  const resolved = path.resolve(base, relPath);
  const normBase = normalizeForCompare(base);
  const normResolved = normalizeForCompare(resolved);
  if (normResolved !== normBase && !normResolved.startsWith(normBase + path.sep)) {
    throw new Error(`Path escapes ${spriteDirName}: ${relPath}`);
  }
  return resolved;
}

/**
 * Generic containment guard: resolve `relPath` against an arbitrary absolute
 * base dir with the same traversal rules as resolveInsideSpriteDir (no
 * absolutes, no `..`, no escape). Used by the export writer — adapters emit
 * relPaths, the user picks the base dir; neither may write outside it.
 */
export function resolveInsideDir(baseAbs: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) {
    throw new Error('Path must be a non-empty relative path');
  }
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new Error(`Absolute paths are not allowed: ${relPath}`);
  }
  if (relPath.split(/[\\/]+/).includes('..')) {
    throw new Error(`Path traversal ("..") is not allowed: ${relPath}`);
  }
  const base = path.resolve(baseAbs);
  const resolved = path.resolve(base, relPath);
  const normBase = normalizeForCompare(base);
  const normResolved = normalizeForCompare(resolved);
  if (normResolved !== normBase && !normResolved.startsWith(normBase + path.sep)) {
    throw new Error(`Path escapes the export dir: ${relPath}`);
  }
  return resolved;
}
