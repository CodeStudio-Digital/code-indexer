/**
 * Multi-track column resolution shared by the GIF route and the engine
 * exporters: group an animation's frames by column (frame_index) over the
 * VISIBLE tracks, decode each cell PNG and composite bottom-up. Column
 * durations follow the shared-time-grid rule: track 0 is the master line
 * (its duration_ms, else 1000/fps). A column with no visible cell yields
 * `image: null` — the caller materializes transparency at the grid size.
 */
import fs from 'node:fs';
import { decodeImage } from '@mcp/sprite-studio/processing/decode-image.js';
import { compositeLayers } from '@mcp/sprite-studio/processing/composite.js';
import type { RgbaImage } from '@mcp/sprite-studio/processing/types.js';
import { resolveInsideSpriteDir } from '@mcp/sprite-studio/repo/paths.js';
import { normalizeTracks } from '@mcp/store/sprite-studio/track-settings.js';
import type { ServerDeps } from '../../deps.js';
import type { AnimContext } from './animation-helpers.js';

export interface CompositeColumn {
  /** Composited visible cells, or null when the whole column is empty. */
  image: RgbaImage | null;
  durationMs: number;
}

/**
 * Resolve every column 0..gridLen-1 of the animation. Throws on a missing
 * version file (`missing version N`) or mismatched cell dims inside a column
 * (`layer_size_mismatch` from compositeLayers — Align is the fix).
 */
export function resolveCompositeColumns(deps: ServerDeps, ctx: AnimContext): CompositeColumn[] {
  const { anim, root } = ctx;
  if (!root) throw new Error('no_workspace');
  const frames = deps.spriteAnimationsStore.listFrames(anim.id);
  if (frames.length === 0) return [];
  const visible = new Set(
    normalizeTracks(anim.settings).filter((t) => t.visible).map((t) => t.id),
  );
  // Grid width counts EVERY track (hidden ones hold their columns' timing).
  const gridLen = Math.max(...frames.map((f) => f.frame_index)) + 1;
  const defaultMs = Math.round(1000 / Math.max(1, anim.fps));

  // Per-request decode memo: animations repeat versionIds across columns, and
  // read+inflate per cell is the expensive part (this runs on the Electron
  // MAIN process). Callers may mutate the returned buffer downstream, so cache
  // the pristine decode and hand out a fresh copy per call (memcpy ≪ decode).
  const decoded = new Map<number, RgbaImage>();
  const decodeCell = (versionId: number): RgbaImage => {
    let img = decoded.get(versionId);
    if (!img) {
      const version = deps.spriteAssetsStore.getVersion(versionId);
      if (!version) throw new Error(`missing version ${versionId}`);
      img = decodeImage(fs.readFileSync(resolveInsideSpriteDir(root, version.file_rel_path)));
      decoded.set(versionId, img);
    }
    return { rgba: new Uint8Array(img.rgba), width: img.width, height: img.height };
  };

  const columns: CompositeColumn[] = [];
  for (let col = 0; col < gridLen; col++) {
    // Bottom-up: ascending track id (listFrames orders by track, index).
    const cells = frames.filter((f) => f.frame_index === col && visible.has(f.track));
    const base = frames.find((f) => f.frame_index === col && f.track === 0);
    const durationMs = base?.duration_ms ?? defaultMs;
    if (cells.length === 0) {
      columns.push({ image: null, durationMs });
      continue;
    }
    const images = cells.map((f) => decodeCell(f.version_id));
    columns.push({ image: images.length === 1 ? images[0] : compositeLayers(images), durationMs });
  }
  return columns;
}
