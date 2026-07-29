/**
 * Sprite Studio — manual frame repositioning (preview drag → baked version).
 *
 *   POST /api/sprite-studio/animations/:id/frames/reposition
 *     body { frameIndex, dx, dy, track? }
 *
 * Reads the targeted frame version, moves only the detected subject inside the
 * frame's existing canvas, writes a new immutable edited version, then repoints
 * that one timeline cell. The frame dimensions and animation timing never
 * change.
 */
import fs from 'node:fs';
import type { Hono } from 'hono';
import { normalizeTracks } from '@mcp/store/sprite-studio/track-settings.js';
import { decodePng, encodePng } from '@mcp/sprite-studio/processing/png.js';
import { repositionSubjectOnCanvas } from '@mcp/sprite-studio/processing/reposition.js';
import { resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import type { ServerDeps } from '../../deps.js';
import { resolveAnim, toAnimDto } from './animation-helpers.js';
import { writeEditedVersion } from './version-write.js';

const MAX_OFFSET = 2048;

export interface RepositionFrameInput {
  frameIndex: number;
  dx: number;
  dy: number;
  track: number;
}

export function normalizeRepositionFrameInput(raw: unknown): RepositionFrameInput {
  const body = raw as { frameIndex?: unknown; dx?: unknown; dy?: unknown; track?: unknown } | null;
  const frameIndex = body?.frameIndex;
  const dx = body?.dx;
  const dy = body?.dy;
  const track = body?.track === undefined ? 0 : body.track;
  if (typeof frameIndex !== 'number' || !Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new Error('invalid_body');
  }
  if (typeof dx !== 'number' || !Number.isInteger(dx) || Math.abs(dx) > MAX_OFFSET) {
    throw new Error('invalid_offset');
  }
  if (typeof dy !== 'number' || !Number.isInteger(dy) || Math.abs(dy) > MAX_OFFSET) {
    throw new Error('invalid_offset');
  }
  if (typeof track !== 'number' || !Number.isInteger(track) || track < 0) throw new Error('invalid_track');
  if (dx === 0 && dy === 0) throw new Error('no_offset');
  return { frameIndex, dx, dy, track };
}

export function mountSpriteFrameRepositionRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteFileStore;

  app.post('/api/sprite-studio/animations/:id/frames/reposition', async (c) => {
    const found = await resolveAnim(deps, c.req.param('id'));
    if (!found || !found.root) return c.json({ error: 'not_found' }, 404);
    let input: RepositionFrameInput;
    try {
      input = normalizeRepositionFrameInput(await c.req.json().catch(() => null));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (!normalizeTracks(found.anim.settings).some((t) => t.id === input.track)) {
      return c.json({ error: 'unknown_track' }, 400);
    }

    const frames = await store.listFrames(found.anim.id, input.track);
    const target = frames.find((f) => f.frame_index === input.frameIndex);
    if (!target) return c.json({ error: 'no_frame' }, 400);
    const version = await store.getVersion(target.version_id);
    if (!version || version.asset_id !== found.asset.id) return c.json({ error: 'invalid_version' }, 400);

    try {
      const png = fs.readFileSync(resolveInsideSpriteDir(found.root, version.file_rel_path));
      const source = decodePng(png);
      const repositioned = repositionSubjectOnCanvas(source, { dx: input.dx, dy: input.dy });
      const row = await writeEditedVersion(deps, found.root, found.asset, encodePng(repositioned), {
        setCurrent: false,
        parentVersionId: version.id,
        dims: { width: repositioned.width, height: repositioned.height },
      });
      await store.replaceTrackFrames(
        found.anim.id,
        input.track,
        frames.map((f) => ({
          frame_index: f.frame_index,
          version_id: f.id === target.id ? row.id : f.version_id,
          duration_ms: f.duration_ms,
        })),
      );
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }

    const updated = await store.getAnimation(found.anim.id);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(
      toAnimDto(updated, await store.listFrames(found.anim.id)),
    );
  });
}
