/**
 * Sprite Studio — frame alignment / registration route (timeline "Align").
 *
 *   POST /api/sprite-studio/animations/:id/frames/align
 *     body { anchorX: 'left'|'center'|'right', anchorY: 'top'|'middle'|'bottom',
 *            frameIndexes?: number[] }        // omitted → every frame
 *
 * Generated frame packs drift sideways between frames, breaking registration.
 * Per targeted frame: read its version PNG → sprite worker pipeline
 * [autoCrop → placeOnCanvas] using the FRAME VERSION's own dimensions as the
 * target canvas → write the result as a NEW immutable 'edited' version (the
 * asset's current pointer is NOT moved) → finally repoint the frame list at
 * the aligned versions in one replaceFrames transaction. Split from
 * animations.routes.ts for the 200-LOC ceiling.
 */
import fs from 'node:fs';
import type { Hono } from 'hono';
import { decodePng } from '@mcp/sprite-studio/processing/png.js';
import type { CanvasAnchorX, CanvasAnchorY, SpriteOp } from '@mcp/sprite-studio/processing/types.js';
import { resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import type { ServerDeps } from '../../deps.js';
import { getSpriteWorkerClient } from '../../../sse/SpriteWorkerClient.js';
import { resolveAnim, toAnimDto } from './animation-helpers.js';
import { writeEditedVersion } from './version-write.js';

const ANCHOR_X: ReadonlySet<string> = new Set(['left', 'center', 'right']);
const ANCHOR_Y: ReadonlySet<string> = new Set(['top', 'middle', 'bottom']);

interface AlignBody {
  anchorX?: string;
  anchorY?: string;
  frameIndexes?: unknown;
}

export function normalizeFrameIndexes(raw: unknown): Set<number> | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) throw new Error('invalid_frame_indexes');
  const out = new Set<number>();
  for (const value of raw) {
    if (!Number.isInteger(value) || value < 0) throw new Error('invalid_frame_indexes');
    out.add(value);
  }
  if (out.size === 0) throw new Error('no_frames');
  return out;
}

export function mountSpriteFrameAlignRoutes(app: Hono, deps: ServerDeps): void {
  const store = deps.spriteAnimationsStore;

  app.post('/api/sprite-studio/animations/:id/frames/align', async (c) => {
    const found = resolveAnim(deps, Number(c.req.param('id')));
    if (!found || !found.root) return c.json({ error: 'not_found' }, 404);
    const { anim, asset, root } = found;
    const body = (await c.req.json().catch(() => null)) as AlignBody | null;
    if (!body || !ANCHOR_X.has(body.anchorX ?? '') || !ANCHOR_Y.has(body.anchorY ?? '')) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const anchorX = body.anchorX as CanvasAnchorX;
    const anchorY = body.anchorY as CanvasAnchorY;
    let wanted: Set<number> | null;
    try {
      wanted = normalizeFrameIndexes(body.frameIndexes);
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, 400);
    }
    // Align operates on the BASE track only (replaceFrames below is track-0
    // scoped by contract — overlay layers keep their own registration).
    const frames = store.listFrames(anim.id, 0);
    const targets = frames.filter((f) => !wanted || wanted.has(f.frame_index));
    if (targets.length === 0) return c.json({ error: 'no_frames' }, 400);

    const worker = getSpriteWorkerClient();
    const alignedVersionByFrame = new Map<number, number>();
    try {
      // Sequential on purpose: one worker thread anyway, and ≤8 frames.
      for (const frame of targets) {
        const version = deps.spriteAssetsStore.getVersion(frame.version_id);
        if (!version) throw new Error(`missing version ${frame.version_id}`);
        const png = fs.readFileSync(resolveInsideSpriteDir(root, version.file_rel_path));
        // Target canvas = the frame version's own dims; only the content moves.
        const dims = version.width && version.height
          ? { width: version.width, height: version.height }
          : decodePng(png);
        const ops: SpriteOp[] = [
          { op: 'autoCrop' },
          { op: 'placeOnCanvas', width: dims.width, height: dims.height, anchorX, anchorY },
        ];
        const out = await worker.processPipeline(png.toString('base64'), ops);
        const row = writeEditedVersion(deps, root, asset, Buffer.from(out.pngBase64, 'base64'), {
          // Worker reports the output dims — skip the decode-for-dims on main.
          setCurrent: false, parentVersionId: version.id, dims: { width: out.width, height: out.height },
        });
        alignedVersionByFrame.set(frame.id, row.id);
      }
    } catch (e) {
      // Versions already written are harmless immutable rows; the frame list
      // is only repointed after EVERY target succeeded (all-or-nothing).
      return c.json({ error: (e as Error).message }, 500);
    }
    store.replaceFrames(
      anim.id,
      frames.map((f) => ({
        frame_index: f.frame_index,
        version_id: alignedVersionByFrame.get(f.id) ?? f.version_id,
        duration_ms: f.duration_ms,
      })),
    );
    const updated = store.get(anim.id);
    if (!updated) return c.json({ error: 'not_found' }, 404);
    return c.json(toAnimDto(updated, store.listFrames(anim.id)));
  });
}
