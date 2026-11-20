import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import sharp from 'sharp';
import { mountCoderSessionFilesRoutes } from '../session-files.js';

const roots: string[] = [];
const id = '11111111-1111-4111-8111-111111111111';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('browses and downloads session files without leaving the bundle through paths or junctions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-files-')); roots.push(root);
  const bundle = join(root, 'bundle'); const outside = join(root, 'outside');
  await mkdir(join(bundle, 'generated'), { recursive: true }); await mkdir(outside);
  await writeFile(join(bundle, 'generated', 'report.txt'), 'Generated result');
  await writeFile(join(outside, 'private.txt'), 'Outside');
  await symlink(outside, join(bundle, 'escape'), 'junction');
  const app = new HttpRouter();
  mountCoderSessionFilesRoutes(app, { sessionStore: { getSessionLocation: async (value: string) => value === id ? { bundle_path: bundle } : null } } as never);
  const base = `/api/coder/sessions/${id}/files`;
  const listing = await (await app.request(base)).json();
  expect(listing.entries).toEqual([{ name: 'generated', path: 'generated', type: 'directory' }]);
  expect(listing.parent).toBeNull();
  const download = await app.request(`${base}?path=generated%2Freport.txt&download=1`);
  expect(await download.text()).toBe('Generated result');
  expect(download.headers.get('content-disposition')).toContain('report.txt');
  for (const path of ['../outside/private.txt', 'escape/private.txt', 'C:/Windows', 'generated/report.txt:stream']) {
    expect((await app.request(`${base}?path=${encodeURIComponent(path)}&download=1`)).status).toBe(400);
  }
});
it('pages attachment metadata and downloads the requested original', async () => {
  const listSessionAttachments = vi.fn(async () => ({ items: [{ name: 'photo.png' }], total: 51, next_offset: null }));
  const app = new HttpRouter();
  mountCoderSessionFilesRoutes(app, { sessionStore: { getSessionLocation: async () => ({}), listSessionAttachments,
    readSessionAttachment: async () => ({ name: 'photo.png', bytes: Buffer.from('original') }),
  } } as never);
  expect((await app.request(`/api/coder/sessions/${id}/attachments?offset=50`)).status).toBe(200);
  expect(listSessionAttachments).toHaveBeenCalledWith(id, 50, 50);
  const download = await app.request(`/api/coder/sessions/${id}/attachments/1/0`);
  expect(await download.text()).toBe('original');
  expect((await app.request(`/api/coder/sessions/${id}/attachments/1/-1`)).status).toBe(400);
});

it('serves bounded image thumbnails and preserves original pixels for preview and download', async () => {
  const original = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#7464ca' } }).png().toBuffer();
  const app = new HttpRouter();
  mountCoderSessionFilesRoutes(app, { sessionStore: { getSessionLocation: async () => ({}),
    readSessionAttachment: async (_id: string, _seq: number, index: number) => ({ name: 'generated.png', media_type: index ? 'image/svg+xml' : 'image/png', bytes: original }),
  } } as never);
  const base = `/api/coder/sessions/${id}/attachments/1`;
  const thumbnail = await app.request(`${base}/0?thumbnail=1`);
  expect(thumbnail.status).toBe(200);
  const metadata = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
  expect([metadata.width, metadata.height]).toEqual([160, 120]);
  const preview = await app.request(`${base}/0?preview=1`);
  expect(preview.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await preview.arrayBuffer())).toEqual(original);
  expect(Buffer.from(await (await app.request(`${base}/0`)).arrayBuffer())).toEqual(original);
  expect((await app.request(`${base}/1?preview=1`)).status).toBe(415);
});
