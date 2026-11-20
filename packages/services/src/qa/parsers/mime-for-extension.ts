/**
 * Pure: map a workspace-relative file path to the HTTP `content-type`
 * the artifact endpoint should serve. The whitelist is the union of
 * what `tests/e2e/`, `test-results/`, and `playwright-report/` can
 * legitimately produce — anything else degrades to `application/octet-stream`,
 * which nudges browsers to download instead of executing.
 *
 * Exported standalone (not inlined in the route) so unit tests don't
 * need a request context to verify the mapping.
 */

const TABLE: Readonly<Record<string, string>> = {
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webm: 'video/webm',
  mp4: 'video/mp4',
  webp: 'image/webp',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  map: 'application/json; charset=utf-8',
};

const DEFAULT_MIME = 'application/octet-stream';

/**
 * Pure: resolve the MIME for a path's last extension. Case-insensitive.
 * Returns `application/octet-stream` for unknown / missing extensions.
 */
export function mimeForExtension(path: string): string {
  if (typeof path !== 'string' || !path.trim()) return DEFAULT_MIME;
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0 || dot === lower.length - 1) return DEFAULT_MIME;
  const ext = lower.slice(dot + 1);
  return TABLE[ext] ?? DEFAULT_MIME;
}

/**
 * Pure: file extension (without the dot). Empty string when missing.
 * Exported for tests that need to assert the same lookup the route uses.
 */
export function extensionOf(path: string): string {
  if (typeof path !== 'string') return '';
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return '';
  return path.slice(dot + 1).toLowerCase();
}
