/**
 * Layer compositing for multi-track animation columns: straight-alpha
 * source-over, bottom-up (layers[0] underneath). Pure and cheap enough for
 * the main process (12 cols × 4 tracks × 256² ≈ ms) — no worker RPC needed;
 * promote to one later only if profiling demands it.
 */
import type { RgbaImage } from './types.js';

/**
 * Composite same-sized layers bottom-up into a fresh image. Throws
 * `layer_size_mismatch` when dimensions diverge — the sanctioned fix is the
 * frame Align tool (each cell of a column must share the canvas).
 */
export function compositeLayers(layers: RgbaImage[]): RgbaImage {
  if (layers.length === 0) throw new Error('compositeLayers: no layers');
  const { width, height } = layers[0];
  for (const l of layers) {
    if (l.width !== width || l.height !== height) {
      throw new Error(
        `layer_size_mismatch: ${l.width}x${l.height} vs ${width}x${height} — align the frames first`,
      );
    }
  }
  const out = new Uint8Array(layers[0].rgba); // bottom layer copy
  for (let li = 1; li < layers.length; li++) {
    const src = layers[li].rgba;
    for (let p = 0; p < out.length; p += 4) {
      const sa = src[p + 3] / 255;
      if (sa <= 0) continue;
      if (sa >= 1) {
        out[p] = src[p];
        out[p + 1] = src[p + 1];
        out[p + 2] = src[p + 2];
        out[p + 3] = 255;
        continue;
      }
      const da = out[p + 3] / 255;
      const outA = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        out[p + c] = Math.round((src[p + c] * sa + out[p + c] * da * (1 - sa)) / outA);
      }
      out[p + 3] = Math.round(outA * 255);
    }
  }
  return { rgba: out, width, height };
}

/** A fully transparent image (empty multi-track column placeholder). */
export function transparentImage(width: number, height: number): RgbaImage {
  return { rgba: new Uint8Array(width * height * 4), width, height };
}
