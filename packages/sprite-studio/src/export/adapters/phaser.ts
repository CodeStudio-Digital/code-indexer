/**
 * Phaser 3 atlas adapter — TexturePacker "JSON (hash)" compatible, the shape
 * `this.load.atlas(key, png, json)` consumes. `rotated` is always false
 * (pixel art never rotates); trimmed/spriteSourceSize/sourceSize come from
 * the FrameRect (grid frames are untrimmed full cells).
 */
import type { ComposedSheet, ExportMeta, FrameRect } from '../atlas-types.js';

interface PhaserFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  pivot: { x: number; y: number };
}

export interface PhaserAtlasJson {
  frames: Record<string, PhaserFrame>;
  meta: {
    app: string;
    version: string;
    image: string;
    format: 'RGBA8888';
    size: { w: number; h: number };
    scale: string;
  };
}

function toPhaserFrame(rect: FrameRect, meta: ExportMeta): PhaserFrame {
  return {
    frame: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    rotated: false,
    trimmed: rect.trimmed ?? false,
    spriteSourceSize: rect.spriteSourceSize ?? { x: 0, y: 0, w: rect.w, h: rect.h },
    sourceSize: rect.sourceSize ?? { w: rect.w, h: rect.h },
    pivot: rect.pivot ?? meta.pivot,
  };
}

export function buildPhaserAtlas(
  sheet: ComposedSheet,
  meta: ExportMeta,
  imageName: string,
): PhaserAtlasJson {
  const frames: Record<string, PhaserFrame> = {};
  for (const rect of sheet.rects) {
    frames[rect.name] = toPhaserFrame(rect, meta);
  }
  return {
    frames,
    meta: {
      app: 'CodeStudio Sprite Studio',
      version: '1.0',
      image: imageName,
      format: 'RGBA8888',
      size: { w: sheet.rgba.width, h: sheet.rgba.height },
      scale: String(meta.scale),
    },
  };
}

/** Serialized adapter output (2-space JSON + trailing newline). */
export function phaserAtlasText(sheet: ComposedSheet, meta: ExportMeta, imageName: string): string {
  return `${JSON.stringify(buildPhaserAtlas(sheet, meta, imageName), null, 2)}\n`;
}
