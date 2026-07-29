/**
 * Animated-GIF preview route (extracted from animations.routes.ts for the
 * LOC ceiling + multi-track). Columns are resolved/composited over the
 * VISIBLE tracks (composite-helpers), encoded off-thread by the sprite
 * worker. Ping-pong is baked into the sequence (GIF has no native mode);
 * 'once' maps to repeat none. Single-track animations produce byte-identical
 * output (composite of one layer = copy).
 */
import type { Hono } from 'hono';
import { encodePng } from '@mcp/sprite-studio/processing/png.js';
import { transparentImage } from '@mcp/sprite-studio/processing/composite.js';
import { expandPingpong } from '@mcp/sprite-studio/export/gif.js';
import type { ServerDeps } from '../../deps.js';
import { getSpriteWorkerClient } from '../../../sse/SpriteWorkerClient.js';
import { resolveAnim } from './animation-helpers.js';
import { resolveCompositeColumns } from './composite-helpers.js';

export function mountSpriteGifRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/sprite-studio/animations/:id/gif', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found || !found.root) return c.json({ error: 'not_found' }, 404);
    const { anim, asset } = found;

    let columns;
    try {
      columns = await resolveCompositeColumns(deps, found);
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith('layer_size_mismatch') ? 422 : 404);
    }
    if (columns.length === 0) return c.json({ error: 'no_frames' }, 404);

    // Empty columns render transparent at the grid's cell size (hold blank).
    const ref = columns.find((col) => col.image != null)?.image;
    if (!ref) return c.json({ error: 'no_frames' }, 404);
    let pngs = columns.map((col) =>
      encodePng(col.image ?? transparentImage(ref.width, ref.height)).toString('base64'),
    );
    let durations = columns.map((col) => col.durationMs);
    if (anim.loop_mode === 'pingpong') {
      pngs = expandPingpong(pngs);
      durations = expandPingpong(durations);
    }
    try {
      const gifBase64 = await getSpriteWorkerClient().encodeGif(
        pngs, durations, anim.loop_mode === 'once' ? 'once' : 'loop',
      );
      return c.body(new Uint8Array(Buffer.from(gifBase64, 'base64')), {
        headers: {
          'content-type': 'image/gif',
          'content-disposition': `inline; filename="${asset.slug}_${anim.name}.gif"`,
          'cache-control': 'no-store', // frames/durations change between calls
        },
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });
}
