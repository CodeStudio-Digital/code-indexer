/**
 * Routes — Design System versions list / detail / docs / storybook proxy.
 *
 *   GET  /api/design-system/sessions/:id/versions
 *   GET  /api/design-system/sessions/:id/versions/:semver
 *   GET  /api/design-system/sessions/:id/versions/:semver/docs           (markdown body)
 *   GET  /api/design-system/sessions/:id/versions/:semver/components
 *   GET  /api/design-system/sessions/:id/versions/:semver/storybook/*    (file proxy)
 *
 * Storybook proxy reads the persisted `storybook_path` (relative to the
 * container workdir or absolute on host) and serves files from there.
 * The package's `storybook-static/` is also bundled in the published
 * tarball, so this proxy is a convenience for the dashboard to embed
 * via iframe without unpacking the tarball.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import type { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { parseIdParam, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export function mountDesignSystemVersionRoutes(app: Hono, deps: ServerDeps): void {
  const { designSystemStore } = deps;

  app.get('/api/design-system/sessions/:id/versions', (c) => {
    const id = parseIdParam(c);
    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);
    return c.json({ versions: designSystemStore.listVersions(id) });
  });

  app.get('/api/design-system/sessions/:id/versions/:semver', (c) => {
    const id = parseIdParam(c);
    const semver = c.req.param('semver') ?? '';
    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);
    const version = designSystemStore.getVersionBySemver(id, semver);
    if (!version) return notFound(c, `Version '${semver}' not found.`);
    const components = designSystemStore.listComponents(version.id);
    return c.json({ version, components });
  });

  app.get('/api/design-system/sessions/:id/versions/:semver/docs', (c) => {
    const id = parseIdParam(c);
    const semver = c.req.param('semver') ?? '';
    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);
    const version = designSystemStore.getVersionBySemver(id, semver);
    if (!version) return notFound(c, `Version '${semver}' not found.`);
    return c.body(version.docs_md ?? '', 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  app.get('/api/design-system/sessions/:id/versions/:semver/components', (c) => {
    const id = parseIdParam(c);
    const semver = c.req.param('semver') ?? '';
    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);
    const version = designSystemStore.getVersionBySemver(id, semver);
    if (!version) return notFound(c, `Version '${semver}' not found.`);
    return c.json({ components: designSystemStore.listComponents(version.id) });
  });

  // Storybook static proxy. Path is everything after `/storybook/`.
  app.get('/api/design-system/sessions/:id/versions/:semver/storybook/*', async (c) => {
    const id = parseIdParam(c);
    const semver = c.req.param('semver') ?? '';
    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);
    const version = designSystemStore.getVersionBySemver(id, semver);
    if (!version) return notFound(c, `Version '${semver}' not found.`);
    if (!version.storybook_path) {
      return c.json({ error: 'No Storybook build for this version.' }, 404);
    }
    // Compute requested file relative to storybook_path. The route param
    // captures the wildcard via a star — we strip the prefix manually.
    const url = new URL(c.req.url);
    const prefix = `/api/design-system/sessions/${id}/versions/${encodeURIComponent(semver)}/storybook/`;
    const idx = url.pathname.indexOf(prefix);
    let rel = idx >= 0 ? decodeURIComponent(url.pathname.slice(idx + prefix.length)) : '';
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    // Defensive against path traversal.
    const safeRel = normalize(rel).replace(/^([\/\\]+)/, '');
    if (safeRel.includes('..')) {
      return c.json({ error: 'Invalid path.' }, 400);
    }
    const root = resolvePath(version.storybook_path);
    const target = resolvePath(join(root, safeRel));
    if (!target.startsWith(root)) {
      return c.json({ error: 'Path escapes storybook root.' }, 400);
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      return notFound(c, `Storybook asset not found: ${safeRel}`);
    }
    const mime = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
    return stream(c, async (s) => {
      c.header('Content-Type', mime);
      const r = createReadStream(target);
      for await (const chunk of r) {
        await s.write(chunk as Uint8Array);
      }
    });
  });
}
