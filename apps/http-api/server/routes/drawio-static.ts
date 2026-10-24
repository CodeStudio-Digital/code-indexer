/**
 * Self-hosted draw.io webapp — serves the vendored embed build at `/drawio/*`.
 *
 * The dashboard iframes `mcp://app/drawio/index.html?embed=1&proto=json…`
 * (Electron) or `<backend>/drawio/…` (browser dev). The packaged CSP already
 * allows this origin (`frame-src 'self' mcp://app http://localhost:*` in
 * apps/electron/src/security-hardening.ts) — no remote CDN, works offline.
 *
 * Vendoring: the static bundle lives in `apps/http-api/vendor/drawio/` (see
 * that folder's VENDOR.md / `pnpm drawio:fetch`). In a packaged build it's
 * copied to `resources/drawio` via electron-builder `extraResources`. When the
 * bundle is missing, `index.html` returns a friendly placeholder instead of a
 * blank iframe so the gap is obvious.
 */
import { existsSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

let cachedDir: string | null | undefined;

/** Resolve the vendored draw.io directory once (env → packaged → source). */
export function drawioVendorDir(): string | null {
  if (cachedDir !== undefined) return cachedDir;
  const candidates: string[] = [];
  if (process.env.MCP_DRAWIO_DIR) candidates.push(process.env.MCP_DRAWIO_DIR);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'drawio'));
  // Source / dev: this module sits at apps/http-api/server/routes — the vendor
  // dir is two levels up. Works for tsx (source) and the mirrored dist layout.
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, '../../vendor/drawio'));
    // Development launches compiled dist/apps/http-api while the vendored
    // editor stays in the source tree (electron-builder copies it separately).
    candidates.push(path.resolve(here, '../../../../../apps/http-api/vendor/drawio'));
  } catch {
    /* import.meta.url unavailable — skip */
  }
  cachedDir = candidates.find((d) => existsSync(path.join(d, 'index.html'))) ?? null;
  return cachedDir;
}

/** Minimal placeholder when the bundle isn't vendored — keeps the iframe honest. */
const PLACEHOLDER = `<!doctype html><html><head><meta charset="utf-8"><title>draw.io not installed</title>
<style>body{font:14px/1.5 system-ui,sans-serif;color:#ddd;background:#1e1e1e;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}code{background:#333;padding:2px 6px;border-radius:4px}</style></head>
<body><div><p>The draw.io editor isn't installed yet.</p><p>Run <code>pnpm drawio:fetch</code> to vendor it into <code>apps/http-api/vendor/drawio</code>.</p></div></body></html>`;

export function mountDrawioStaticRoutes(app: Hono): void {
  app.get('/drawio/*', async (c) => {
    const dir = drawioVendorDir();
    const rel = c.req.path.replace(/^\/drawio\/?/, '') || 'index.html';
    // Containment: reject traversal outside the vendor dir.
    const safeRel = path.normalize(rel).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
    if (!dir) {
      return c.html(PLACEHOLDER, rel === 'index.html' || rel === '' ? 200 : 404);
    }
    const abs = path.join(dir, safeRel);
    if (!abs.startsWith(path.resolve(dir))) return c.text('forbidden', 403);
    try {
      const s = await stat(abs);
      if (!s.isFile()) return c.text('not found', 404);
      const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
      const body = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream;
      return c.body(body, 200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
    } catch {
      return c.text('not found', 404);
    }
  });
}
