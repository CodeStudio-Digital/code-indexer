import type { RgbaImage } from './types.js';

export interface ThresholdAlphaParams {
  /** Alpha values >= threshold become 255, below become 0. Default 128. */
  threshold?: number;
}

/**
 * Snap every alpha value to fully opaque or fully transparent — the
 * pixel-perfect cleanup pass (pixel art has no semi-transparency).
 * RGB channels are left untouched.
 */
export function thresholdAlpha(img: RgbaImage, params: ThresholdAlphaParams = {}): RgbaImage {
  const threshold = params.threshold ?? 128;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
    throw new Error(`thresholdAlpha threshold must be 0-255, got ${threshold}`);
  }
  const out = new Uint8Array(img.rgba);
  for (let i = 3; i < out.length; i += 4) {
    out[i] = out[i] >= threshold ? 255 : 0;
  }
  return { rgba: out, width: img.width, height: img.height };
}
