import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { HttpRouter } from '@mcp/shared/http/router.js';
import { assertContainedPath, assertPathHasNoLinks, UnsafeSessionPathError } from '@mcp/session-storage';
import type { ServerDeps } from '../../deps.js';
import { notFound, parseSeqParam, parseSessionIdParam } from '../_helpers.js';

function offset(value?: string): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
function disposition(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`;
}

/** Browse only this session's bundle. No recursive tree or attachment bodies on list. */
export function mountCoderSessionFilesRoutes(app: HttpRouter, { sessionStore: store }: ServerDeps) {
  app.get('/api/coder/sessions/:id/attachments', async c => {
    const id = parseSessionIdParam(c);
    if (!await store.getSessionLocation(id)) return notFound(c);
    return c.json(await store.listSessionAttachments(id, offset(c.req.query('offset')), 50));
  });
  app.get('/api/coder/sessions/:id/attachments/:seq/:index', async c => {
    const id = parseSessionIdParam(c);
    const index = Number(c.req.param('index'));
    if (!Number.isSafeInteger(index) || index < 0) return c.json({ error: 'Invalid attachment index' }, 400);
    if (!await store.getSessionLocation(id)) return notFound(c);
    const file = await store.readSessionAttachment(id, parseSeqParam(c), index);
    if (!file) return notFound(c);
    if (c.req.query('thumbnail') === '1' || c.req.query('preview') === '1') {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.media_type)) return c.json({ error: 'Not an image' }, 415);
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Cache-Control', 'private, max-age=60');
      if (c.req.query('preview') === '1') {
        c.header('Content-Type', file.media_type);
        return c.body(new Uint8Array(file.bytes));
      }
      const { prepareVisionImage } = await import('@mcp/services/services/docs/vision-image.js');
      const thumbnail = await prepareVisionImage(Buffer.from(file.bytes), { maxDimension: 160 });
      c.header('Content-Type', thumbnail.mediaType);
      return c.body(new Uint8Array(Buffer.from(thumbnail.base64, 'base64')));
    }
    c.header('Content-Type', 'application/octet-stream');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', disposition(file.name));
    return c.body(new Uint8Array(file.bytes));
  });
  app.get('/api/coder/sessions/:id/files', async c => {
    const location = await store.getSessionLocation(parseSessionIdParam(c));
    if (!location) return notFound(c);
    try {
      const root = location.bundle_path;
      const requested = c.req.query('path') ?? '';
      if (isAbsolute(requested) || requested.includes('\0') || requested.includes(':')) return c.json({ error: 'Invalid session path' }, 400);
      const target = resolve(root, requested);
      assertContainedPath(root, target);
      await assertPathHasNoLinks(root, target);
      const stat = await lstat(target);
      if (c.req.query('download') === '1') {
        if (!stat.isFile()) return c.json({ error: 'Not a file' }, 400);
        c.header('Content-Type', 'application/octet-stream');
        c.header('X-Content-Type-Options', 'nosniff');
        c.header('Content-Disposition', disposition(basename(target)));
        return c.body(Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>);
      }
      if (!stat.isDirectory()) return c.json({ error: 'Not a directory' }, 400);
      const all = (await readdir(target, { withFileTypes: true }))
        .filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const start = offset(c.req.query('offset'));
      const entries = all.slice(start, start + 100).map(entry => ({
        name: entry.name, path: relative(root, resolve(target, entry.name)).split(sep).join('/'),
        type: entry.isDirectory() ? 'directory' : 'file',
      }));
      return c.json({ root_path: root, path: relative(root, target).split(sep).join('/'),
        parent: target === resolve(root) ? null : relative(root, dirname(target)).split(sep).join('/'),
        entries, next_offset: start + entries.length < all.length ? start + entries.length : null });
    } catch (error) {
      if (error instanceof UnsafeSessionPathError) return c.json({ error: 'Invalid session path' }, 400);
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return notFound(c);
      throw error;
    }
  });
}
