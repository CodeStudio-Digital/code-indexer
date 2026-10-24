import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import type { ContentBlock } from '@mcp/provider-sdk';
import { parseSeqParam, parseSessionIdParam, notFound } from '../_helpers.js';
import { prepareVisionImage } from '@mcp/services/services/docs/vision-image.js';

/** Fetch one visible image at a time, instead of downloading all message attachments. */
export function registerSessionImageRoutes(app: Hono, store: ServerDeps['sessionStore']) {
  app.get('/api/coder/sessions/:id/messages/:seq/images/:index', async c => {
    const index = Number(c.req.param('index'));
    if (!Number.isSafeInteger(index) || index < 0) return c.json({ error: 'Invalid image index' }, 400);
    const message = await store.getMessageBySeq(parseSessionIdParam(c), parseSeqParam(c));
    const blocks = Array.isArray(message?.content) ? message.content as ContentBlock[] : [];
    const image = blocks.filter(block => block.type === 'image')[index];
    if (!image || image.type !== 'image' || !image.base64) return notFound(c, 'image not found');
    try {
      let bytes = Buffer.from(image.base64, 'base64');
      let mediaType = image.mediaType;
      if (c.req.query('thumbnail') === '1') {
        const thumbnail = await prepareVisionImage(bytes, { maxDimension: 320 });
        bytes = Buffer.from(thumbnail.base64, 'base64');
        mediaType = thumbnail.mediaType;
      }
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
        return c.json({ error: 'Unsupported image type' }, 415);
      }
      c.header('Content-Type', mediaType);
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Cache-Control', 'private, max-age=60');
      return c.body(new Uint8Array(bytes));
    } catch { return c.json({ error: 'Unable to decode image' }, 422); }
  });
}
