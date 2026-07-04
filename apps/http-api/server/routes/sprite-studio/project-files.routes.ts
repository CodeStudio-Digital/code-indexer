/**
 * Sprite Studio — project file browsing routes (left rail "files" tab).
 *
 *   GET /api/sprite-studio/projects/:projectId/images?dir=<rel>
 *       → { dirs: string[], images: [{ rel, name, size }] } — ONE directory
 *         level under the IDE project root. Only image files
 *         (png/jpg/jpeg/gif/webp); noisy dirs (node_modules/.git/dist)
 *         excluded; capped at 500 entries. 400 invalid path, 404 missing.
 *   GET /api/sprite-studio/projects/:projectId/images/file?rel=<path>
 *       → raw bytes (content-type by extension, cache-control private
 *         max-age=60) for direct use in <img src>.
 *
 * PATH SAFETY: every rel path goes through `resolveInsideRoot` — a mirror
 * of @mcp/sprite-studio's resolveInsideSpriteDir rooted at the PROJECT
 * root (the sprite one stays strict and untouched) — plus a realpath
 * containment re-check (`assertRealInsideRoot`) so symlinks/junctions
 * inside the tree cannot escape it. Directory entries that are symlinks
 * are skipped by the Dirent type checks in the listing.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist']);
const MAX_ENTRIES = 500;

export function isImageFile(name: string): boolean {
  return path.extname(name).toLowerCase() in IMAGE_MIME;
}

function normalizeForCompare(p: string): string {
  // Windows paths are case-insensitive; compare case-folded there.
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolve `relPath` against the PROJECT root and return the absolute path.
 * Rejects (throws): empty input; absolute paths (POSIX, drive-letter and
 * UNC forms); any `..` segment; anything resolving outside the root.
 */
export function resolveInsideRoot(root: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim().length === 0) {
    throw new Error('Path inside the project root must be a non-empty relative path');
  }
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new Error(`Absolute paths are not allowed: ${relPath}`);
  }
  const segments = relPath.split(/[\\/]+/);
  if (segments.includes('..')) {
    throw new Error(`Path traversal ("..") is not allowed: ${relPath}`);
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, relPath);
  const normBase = normalizeForCompare(base);
  const normResolved = normalizeForCompare(resolved);
  if (normResolved !== normBase && !normResolved.startsWith(normBase + path.sep)) {
    throw new Error(`Path escapes the project root: ${relPath}`);
  }
  return resolved;
}

/**
 * Follow symlinks (realpath) and require the target stays inside the
 * realpathed root. Throws when `abs` does not exist or escapes. Returns
 * the real absolute path to read from.
 */
export function assertRealInsideRoot(root: string, abs: string): string {
  const realRoot = fs.realpathSync(path.resolve(root));
  const real = fs.realpathSync(abs);
  const normBase = normalizeForCompare(realRoot);
  const normReal = normalizeForCompare(real);
  if (normReal !== normBase && !normReal.startsWith(normBase + path.sep)) {
    throw new Error(`Path escapes the project root after resolving links: ${abs}`);
  }
  return real;
}

export function mountSpriteProjectFileRoutes(app: Hono, deps: ServerDeps): void {
  const rootOf = (c: { req: { param(k: string): string } }): string | null => {
    const ideProjectId = Number(c.req.param('projectId'));
    if (!Number.isFinite(ideProjectId)) return null;
    return deps.db.getProject(ideProjectId)?.root_path ?? null;
  };

  app.get('/api/sprite-studio/projects/:projectId/images', (c) => {
    const root = rootOf(c);
    if (!root) return c.json({ error: 'no_workspace' }, 404);
    const dirRaw = (c.req.query('dir') ?? '').trim();
    let abs: string;
    try {
      abs = dirRaw ? resolveInsideRoot(root, dirRaw) : path.resolve(root);
    } catch {
      return c.json({ error: 'invalid_path' }, 400);
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(assertRealInsideRoot(root, abs), { withFileTypes: true });
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
    // Canonical '/'-separated prefix for the returned rel paths.
    const relDir = dirRaw.split(/[\\/]+/).filter(Boolean).join('/');
    const dirs: string[] = [];
    const images: Array<{ rel: string; name: string; size: number }> = [];
    for (const e of entries) {
      if (dirs.length + images.length >= MAX_ENTRIES) break;
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.has(e.name)) dirs.push(e.name);
      } else if (e.isFile() && isImageFile(e.name)) {
        let size = 0;
        try { size = fs.statSync(path.join(abs, e.name)).size; } catch { continue; }
        images.push({ rel: relDir ? `${relDir}/${e.name}` : e.name, name: e.name, size });
      }
    }
    dirs.sort((a, b) => a.localeCompare(b));
    images.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ dirs, images });
  });

  app.get('/api/sprite-studio/projects/:projectId/images/file', (c) => {
    const root = rootOf(c);
    if (!root) return c.json({ error: 'no_workspace' }, 404);
    const rel = c.req.query('rel') ?? '';
    const mime = IMAGE_MIME[path.extname(rel).toLowerCase()];
    if (!mime) return c.json({ error: 'unsupported_type' }, 400);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(assertRealInsideRoot(root, resolveInsideRoot(root, rel)));
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.body(new Uint8Array(bytes), {
      headers: { 'content-type': mime, 'cache-control': 'private, max-age=60' },
    });
  });
}
