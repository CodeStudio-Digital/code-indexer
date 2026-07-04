/**
 * Babylon.js SpriteManager manifest — Babylon has NO official atlas format
 * (SpriteManager takes cellWidth/cellHeight at construction and frame index
 * ranges at play time), so this emits a small documented JSON
 * (`babylon-sprite-v1`) that a loader shim feeds into
 * `new SpriteManager(name, image, capacity, {width: cellWidth, height:
 * cellHeight})` + `sprite.playAnimation(from, to, loop, delayMs)`.
 *
 * Baked-in limitations of that API: playAnimation walks a CONTIGUOUS index
 * range (from..to — animations here come as contiguous frame runs, so
 * min/max of the resolved indices), has a single per-animation delay
 * (durationsMs[0] wins when present, else 1000/fps) and no ping-pong mode —
 * loopMode 'pingpong' exports as `loop: true`.
 */
import type { ComposedSheet, ExportMeta } from '../atlas-types.js';

export interface BabylonSpriteManifest {
  meta: { app: 'CodeStudio Sprite Studio'; format: 'babylon-sprite-v1'; image: string };
  /** Uniform cell size (composeGrid sheets are uniform grids). */
  cellWidth: number;
  cellHeight: number;
  frameCount: number;
  animations: Record<
    string,
    { from: number; to: number; fps: number; loop: boolean; delayMs: number }
  >;
}

export function buildBabylonManifest(
  sheet: ComposedSheet,
  meta: ExportMeta,
  imageName: string,
): BabylonSpriteManifest {
  const first = sheet.rects[0];
  const nameToIndex = new Map(sheet.rects.map((r, i) => [r.name, i] as const));
  const animations: BabylonSpriteManifest['animations'] = {};
  for (const [name, anim] of Object.entries(meta.animations ?? {})) {
    const indices = anim.frames
      .map((f) => nameToIndex.get(f))
      .filter((i): i is number => i !== undefined);
    const fps = anim.fps ?? meta.fps ?? 8;
    animations[name] = {
      from: indices.length > 0 ? Math.min(...indices) : 0,
      to: indices.length > 0 ? Math.max(...indices) : 0,
      fps,
      loop: anim.loopMode !== undefined ? anim.loopMode !== 'once' : anim.loop !== false,
      delayMs: Math.round(anim.durationsMs?.[0] ?? 1000 / fps),
    };
  }
  return {
    meta: { app: 'CodeStudio Sprite Studio', format: 'babylon-sprite-v1', image: imageName },
    cellWidth: first?.w ?? 0,
    cellHeight: first?.h ?? 0,
    frameCount: sheet.rects.length,
    animations,
  };
}

/** Serialized adapter output (2-space JSON + trailing newline). */
export function babylonManifestText(
  sheet: ComposedSheet,
  meta: ExportMeta,
  imageName: string,
): string {
  return `${JSON.stringify(buildBabylonManifest(sheet, meta, imageName), null, 2)}\n`;
}
