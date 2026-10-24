import { expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import sharp from 'sharp';
import { registerSessionImageRoutes } from '../session-images.js';

it('serves one bounded thumbnail or original without downloading the other attachments', async () => {
  const bytes = await sharp({ create: { width: 1200, height: 600, channels: 3, background: 'red' } }).png().toBuffer();
  const getMessageBySeq = vi.fn(async () => ({ content: [
    { type: 'text', text: 'Two images' },
    { type: 'image', mediaType: 'image/png', base64: bytes.toString('base64') },
    { type: 'image', mediaType: 'image/png', base64: bytes.toString('base64') },
  ] }));
  const app = new Hono(); registerSessionImageRoutes(app, { getMessageBySeq } as never);
  const path = '/api/coder/sessions/019d62cc-3579-7a25-a720-89929baf2e51/messages/1/images/1';
  const thumbnail = await app.request(`${path}?thumbnail=1`);
  expect(thumbnail.status).toBe(200);
  const metadata = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
  expect(metadata).toMatchObject({ width: 320, height: 160 });
  expect(getMessageBySeq).toHaveBeenCalledTimes(1);
  const original = await app.request(path);
  expect(original.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes);
  expect((await app.request(path.replace('/images/1', '/images/2'))).status).toBe(404);
  expect((await app.request(path.replace('/images/1', '/images/-1'))).status).toBe(400);
});
