/**
 * `sprite-studio-v1` generic atlas JSON (plan PARTE 1 §1.5): engine-agnostic
 * frame map + optional animations. Pivot is normalized, y-down. `rotated`
 * never happens (pixel art is not rotated), so the format simply omits it.
 */
import type { ComposedSheet, ExportMeta } from '../atlas-types.js';

export interface GenericAtlasJson {
  meta: {
    app: 'CodeStudio Sprite Studio';
    format: 'sprite-studio-v1';
    image: string;
    size: { w: number; h: number };
    scale: number;
  };
  /** Uniform cell size (every grid frame shares it). */
  frameSize: { w: number; h: number };
  /** Normalized default pivot (0..1, y-down), e.g. bottom-center {x:.5,y:1}. */
  pivot: { x: number; y: number };
  frames: Array<{ name: string; x: number; y: number; w: number; h: number }>;
  animations?: Record<string, { frames: string[]; fps?: number; loop?: boolean }>;
}

export function buildGenericAtlas(
  sheet: ComposedSheet,
  meta: ExportMeta,
  imageName: string,
): GenericAtlasJson {
  const first = sheet.rects[0];
  const atlas: GenericAtlasJson = {
    meta: {
      app: 'CodeStudio Sprite Studio',
      format: 'sprite-studio-v1',
      image: imageName,
      size: { w: sheet.rgba.width, h: sheet.rgba.height },
      scale: meta.scale,
    },
    frameSize: { w: first?.w ?? 0, h: first?.h ?? 0 },
    pivot: meta.pivot,
    frames: sheet.rects.map((r) => ({ name: r.name, x: r.x, y: r.y, w: r.w, h: r.h })),
  };
  if (meta.animations && Object.keys(meta.animations).length > 0) {
    atlas.animations = meta.animations;
  }
  return atlas;
}

/** Serialized adapter output (2-space JSON + trailing newline). */
export function genericAtlasText(sheet: ComposedSheet, meta: ExportMeta, imageName: string): string {
  return `${JSON.stringify(buildGenericAtlas(sheet, meta, imageName), null, 2)}\n`;
}
