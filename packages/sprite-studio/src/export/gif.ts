/**
 * Animated-GIF preview encoder (plan §1.5 F2) — pure function over RGBA
 * bitmaps via `gifenc` (pure JS): frames + per-frame durations → GIF buffer.
 * Runs inside the sprite worker (`gif.encode` RPC); encoding n small frames
 * is CPU-bound like every other image op.
 *
 * Transparency: each frame is quantized with format 'rgba4444' + oneBitAlpha
 * (GIF alpha is 1-bit); the palette slot with alpha 0 becomes the frame's
 * transparent index and disposal 2 (restore to background) keeps frames from
 * smearing over each other.
 */
import { createRequire } from 'node:module';
import type { RgbaImage } from '../processing/types.js';

// gifenc ships `main` (CJS) + `module` (ESM) but NO `exports` map: under Node
// ESM a named import resolves the CJS build and the export-lexer misses its
// symbols ("does not provide an export named 'GIFEncoder'" at app boot).
// createRequire loads the CJS build reliably in Node, Electron main AND vitest.
const { GIFEncoder, applyPalette, quantize } =
  createRequire(import.meta.url)('gifenc') as typeof import('gifenc');

/** GIF renderers clamp tiny delays; 20ms is the practical floor (plan §1.5). */
export const MIN_FRAME_DELAY_MS = 20;

export interface EncodeGifOptions {
  /** 'loop' repeats forever (default); 'once' plays a single time. */
  repeat?: 'loop' | 'once';
  /** Palette size per frame (2..256, default 256). */
  maxColors?: number;
}

/**
 * Encode frames into an animated GIF. `durationsMs[i]` is frame i's delay
 * (floored at MIN_FRAME_DELAY_MS). All frames must share one size — slices
 * of one frame-pack always do; anything else is a caller bug.
 */
export function encodeGif(
  frames: RgbaImage[],
  durationsMs: number[],
  opts: EncodeGifOptions = {},
): Buffer {
  if (frames.length === 0) throw new Error('encodeGif: no frames');
  if (durationsMs.length !== frames.length) {
    throw new Error(
      `encodeGif: ${frames.length} frames but ${durationsMs.length} durations`,
    );
  }
  const { width, height } = frames[0];
  const maxColors = Math.max(2, Math.min(256, Math.round(opts.maxColors ?? 256)));
  const repeat = opts.repeat === 'once' ? -1 : 0;

  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (frame.width !== width || frame.height !== height) {
      throw new Error(
        `encodeGif: frame ${i} is ${frame.width}x${frame.height}, expected ${width}x${height}`,
      );
    }
    const palette = quantize(frame.rgba, maxColors, { format: 'rgba4444', oneBitAlpha: true });
    const index = applyPalette(frame.rgba, palette, 'rgba4444');
    const transparentIndex = palette.findIndex((p) => p.length > 3 && p[3] === 0);
    gif.writeFrame(index, width, height, {
      palette,
      delay: Math.max(MIN_FRAME_DELAY_MS, Math.round(durationsMs[i])),
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
      dispose: 2,
      repeat,
    });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/**
 * Ping-pong expansion: [a,b,c,d] → [a,b,c,d,c,b] (endpoints not doubled).
 * GIF has no native ping-pong, so the sequence is baked before encoding.
 * Works on frames and durations alike — call it on both, same order.
 */
export function expandPingpong<T>(items: T[]): T[] {
  if (items.length < 3) return [...items];
  return [...items, ...items.slice(1, -1).reverse()];
}
