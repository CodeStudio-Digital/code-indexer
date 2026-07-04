import { describe, expect, it } from 'vitest';
import { thresholdAlpha } from '../alpha-cleanup.js';
import { removeBackground } from '../background.js';
import { runPipeline } from '../ops.js';
import { addOutline } from '../outline.js';
import { quantizeToPalette } from '../quantize.js';
import { boxDownscale } from '../resize.js';
import { encode as encodeJpeg } from 'jpeg-js';
import { chromaKeySweep } from '../background.js';
import { decodeImage, sniffImageFormat, stripDataUriPrefix } from '../decode-image.js';
import { fitToCanvas, keepLargestComponent } from '../fit.js';
import { gridFor, sliceGrid } from '../slice.js';
import { decodePng, encodePng } from '../png.js';
import type { RgbaImage } from '../types.js';

/** Build an image from per-pixel [r,g,b,a] rows (row-major). */
function img(width: number, height: number, pixels: number[][]): RgbaImage {
  if (pixels.length !== width * height) throw new Error('pixel count mismatch');
  const rgba = new Uint8Array(width * height * 4);
  pixels.forEach((p, i) => rgba.set(p, i * 4));
  return { rgba, width, height };
}

function px(image: RgbaImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return Array.from(image.rgba.subarray(i, i + 4));
}

describe('decodePng', () => {
  const src = img(2, 2, [
    [255, 0, 0, 255], [0, 255, 0, 255],
    [0, 0, 255, 255], [255, 255, 0, 255],
  ]);

  it('round-trips a clean PNG', () => {
    const decoded = decodePng(encodePng(src));
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(px(decoded, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('tolerates trailing bytes after IEND (AI-backend / CDN re-encode quirk)', () => {
    const dirty = Buffer.concat([encodePng(src), Buffer.from([0, 1, 2, 3, 4, 5])]);
    const decoded = decodePng(dirty);
    expect(decoded.width).toBe(2);
    expect(px(decoded, 1, 1)).toEqual([255, 255, 0, 255]);
  });

  it('rejects a non-PNG buffer with a clear message', () => {
    expect(() => decodePng(Buffer.from('not a png at all'))).toThrow(/not a PNG/);
  });
});

describe('decodeImage (format sniffing)', () => {
  const src = img(2, 2, [
    [255, 0, 0, 255], [0, 255, 0, 255],
    [0, 0, 255, 255], [255, 255, 0, 255],
  ]);

  it('decodes PNG via the png path', () => {
    const out = decodeImage(encodePng(src));
    expect([out.width, out.height]).toEqual([2, 2]);
  });

  it('decodes JPEG output from image backends (Gemini/Workers AI emit it)', () => {
    const jpg = encodeJpeg({ data: Buffer.from(src.rgba), width: 2, height: 2 }, 100);
    expect(sniffImageFormat(jpg.data)).toBe('jpeg');
    const out = decodeImage(jpg.data);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(out.rgba.length).toBe(16);
  });

  it('names WebP explicitly instead of a generic signature error', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '),
    ]);
    expect(() => decodeImage(webp)).toThrow(/WEBP is not supported/);
  });

  it('flags text/error payloads with the readable prefix', () => {
    expect(() => decodeImage(Buffer.from('{"error":"quota exceeded"}'))).toThrow(
      /error payload instead of an image/,
    );
  });

  it('strips data-URI prefixes defensively', () => {
    const b64 = encodePng(src).toString('base64');
    expect(stripDataUriPrefix(`data:image/png;base64,${b64}`)).toBe(b64);
    expect(stripDataUriPrefix(b64)).toBe(b64);
    const out = decodeImage(Buffer.from(stripDataUriPrefix(`data:image/png;base64,${b64}`), 'base64'));
    expect(out.width).toBe(2);
  });
});

describe('framing ops (fit + largest component + chroma sweep)', () => {
  const T: number[] = [0, 0, 0, 0];
  const R: number[] = [255, 0, 0, 255];
  const B: number[] = [0, 0, 255, 255];

  it('keepLargestComponent clears the smaller blob (two-characters defense)', () => {
    // 6×2: RR..B. → 4px red blob (2x2? no: row-major) — build 2 blobs: red 2px, blue 1px.
    const src = img(6, 2, [
      R, R, T, T, B, T,
      R, R, T, T, T, T,
    ]);
    const out = keepLargestComponent(src);
    expect(px(out, 0, 0)[3]).toBe(255); // red kept
    expect(px(out, 4, 0)[3]).toBe(0); // blue cleared
  });

  it('fitToCanvas crops margins and fills the target (no more tiny sprites)', () => {
    // 8×8 canvas with a single 2×2 red blob at (3,3) — 75% empty margins.
    const pixels: number[][] = Array.from({ length: 64 }, () => T);
    for (const [x, y] of [[3, 3], [4, 3], [3, 4], [4, 4]] as const) pixels[y * 8 + x] = R;
    const out = fitToCanvas(img(8, 8, pixels), { width: 8, height: 8, margin: 1 });
    expect([out.width, out.height]).toEqual([8, 8]);
    // The blob now spans the inner 6×6 region instead of 2×2.
    expect(px(out, 1, 1)[3]).toBe(255);
    expect(px(out, 6, 6)[3]).toBe(255);
    expect(px(out, 0, 0)[3]).toBe(0); // margin stays clear
  });

  it('fitToCanvas of fully-transparent input yields an empty target canvas', () => {
    const out = fitToCanvas(img(4, 4, Array.from({ length: 16 }, () => T)), { width: 8, height: 8 });
    expect([out.width, out.height]).toEqual([8, 8]);
    expect(out.rgba.every((v, i) => (i % 4 === 3 ? v === 0 : true))).toBe(true);
  });

  it('chromaKeySweep clears interior key-color islands the border flood misses', () => {
    // magenta frame-enclosed BY red: border flood from edges never reaches it.
    const M: number[] = [255, 0, 255, 255];
    const src = img(3, 3, [
      R, R, R,
      R, M, R,
      R, R, R,
    ]);
    const out = chromaKeySweep(src, { keyColor: '#FF00FF', tolerance: 48 });
    expect(px(out, 1, 1)[3]).toBe(0); // interior magenta gone
    expect(px(out, 0, 0)[3]).toBe(255); // red untouched
  });

  it('chromaKeySweep tolerates JPEG-noise near the key color', () => {
    const nearMagenta: number[] = [246, 12, 244, 255]; // compression drift
    const src = img(1, 1, [nearMagenta]);
    const out = chromaKeySweep(src, { keyColor: '#FF00FF', tolerance: 48 });
    expect(px(out, 0, 0)[3]).toBe(0);
  });
});

describe('sliceGrid (frame-pack)', () => {
  it('cuts a 2x2 grid into 4 cells row-major, preserving pixels', () => {
    const R: number[] = [255, 0, 0, 255];
    const G: number[] = [0, 255, 0, 255];
    const B: number[] = [0, 0, 255, 255];
    const Y: number[] = [255, 255, 0, 255];
    // 4×4: quadrants R G / B Y (each 2×2)
    const src = img(4, 4, [
      R, R, G, G,
      R, R, G, G,
      B, B, Y, Y,
      B, B, Y, Y,
    ]);
    const cells = sliceGrid(src, 2, 2);
    expect(cells).toHaveLength(4);
    expect(cells.every((c) => c.width === 2 && c.height === 2)).toBe(true);
    expect(px(cells[0], 0, 0)).toEqual(R);
    expect(px(cells[1], 0, 0)).toEqual(G);
    expect(px(cells[2], 0, 0)).toEqual(B);
    expect(px(cells[3], 0, 0)).toEqual(Y);
  });

  it('gridFor maps n to sensible layouts', () => {
    expect(gridFor(1)).toEqual({ cols: 1, rows: 1 });
    expect(gridFor(2)).toEqual({ cols: 2, rows: 1 });
    expect(gridFor(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridFor(8)).toEqual({ cols: 4, rows: 2 });
  });
});

describe('quantizeToPalette', () => {
  it('maps to a fixed 2-color palette, preserving alpha and skipping transparent pixels', () => {
    const input = img(2, 2, [
      [10, 10, 10, 255], // near black
      [240, 240, 240, 255], // near white
      [200, 200, 200, 128], // semi-transparent, near white
      [50, 50, 50, 0], // fully transparent: untouched
    ]);
    const out = quantizeToPalette(input, { colors: ['#000000', '#ffffff'], dither: 'none' });
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(out, 1, 0)).toEqual([255, 255, 255, 255]);
    expect(px(out, 0, 1)).toEqual([255, 255, 255, 128]);
    expect(px(out, 1, 1)).toEqual([50, 50, 50, 0]);
    expect(px(input, 0, 0)).toEqual([10, 10, 10, 255]); // input untouched
  });

  it('derives a palette via image-q when only maxColors is given', () => {
    const pixels: number[][] = [];
    for (let i = 0; i < 16; i++) pixels.push(i % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
    const out = quantizeToPalette(img(4, 4, pixels), { maxColors: 2, dither: 'none' });
    const unique = new Set<string>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) unique.add(px(out, x, y).join(','));
    expect(unique.size).toBeLessThanOrEqual(2);
  });

  it('requires colors or maxColors', () => {
    expect(() => quantizeToPalette(img(1, 1, [[0, 0, 0, 255]]), {})).toThrow();
  });
});

describe('boxDownscale', () => {
  it('averages each 2x2 block when downscaling 4x4 -> 2x2', () => {
    const g = (v: number, a = 255) => [v, v, v, a];
    const input = img(4, 4, [
      // row 0: TL block (0,100), TR block (200,200)
      g(0), g(100), g(200), g(200),
      // row 1: TL block (100,0), TR block (200,200)
      g(100), g(0), g(200), g(200),
      // row 2: BL block white/transparent mix, BR block fully transparent
      g(255), g(255, 0), g(0, 0), g(0, 0),
      // row 3
      g(255), g(255, 0), g(0, 0), g(0, 0),
    ]);
    const out = boxDownscale(input, { width: 2, height: 2 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect(px(out, 0, 0)).toEqual([50, 50, 50, 255]); // plain average
    expect(px(out, 1, 0)).toEqual([200, 200, 200, 255]);
    // premultiplied: only opaque white contributes RGB; alpha = mean(255,0,255,0)
    expect(px(out, 0, 1)).toEqual([255, 255, 255, 128]);
    expect(px(out, 1, 1)).toEqual([0, 0, 0, 0]);
  });
});

describe('removeBackground', () => {
  it('clears border-connected background but keeps enclosed same-color pixels', () => {
    const MAG = [255, 0, 255, 255];
    const RED = [255, 0, 0, 255];
    const pixels: number[][] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const inSprite = x >= 2 && x <= 5 && y >= 2 && y <= 5;
        const enclosed = x === 3 && y === 3; // magenta INSIDE the sprite
        pixels.push(enclosed ? [...MAG] : inSprite ? [...RED] : [...MAG]);
      }
    }
    const out = removeBackground(img(8, 8, pixels), { tolerance: 10 });
    expect(px(out, 0, 0)[3]).toBe(0); // border bg cleared
    expect(px(out, 7, 7)[3]).toBe(0);
    expect(px(out, 6, 3)[3]).toBe(0); // bg next to sprite cleared
    expect(px(out, 2, 2)).toEqual(RED); // sprite intact
    expect(px(out, 3, 3)[3]).toBe(255); // enclosed magenta preserved
  });

  it('defringes semi-transparent halos with the nearest opaque RGB', () => {
    const input = img(3, 1, [
      [255, 0, 0, 255], // opaque red
      [200, 100, 100, 128], // halo: keeps alpha, RGB bled from red
      [0, 0, 0, 0], // fully transparent: untouched
    ]);
    const out = removeBackground(input, { tolerance: 0, keyColor: '#00ff00' });
    expect(px(out, 1, 0)).toEqual([255, 0, 0, 128]);
    expect(px(out, 2, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('thresholdAlpha', () => {
  it('snaps alpha to 0 or 255 at the default threshold of 128', () => {
    const input = img(4, 1, [
      [1, 2, 3, 0],
      [1, 2, 3, 100],
      [1, 2, 3, 128],
      [1, 2, 3, 200],
    ]);
    const out = thresholdAlpha(input);
    expect([px(out, 0, 0)[3], px(out, 1, 0)[3], px(out, 2, 0)[3], px(out, 3, 0)[3]]).toEqual([
      0, 0, 255, 255,
    ]);
    expect(px(out, 1, 0).slice(0, 3)).toEqual([1, 2, 3]); // RGB untouched
  });

  it('honors a custom threshold', () => {
    const out = thresholdAlpha(img(1, 1, [[0, 0, 0, 199]]), { threshold: 200 });
    expect(px(out, 0, 0)[3]).toBe(0);
  });
});

describe('addOutline', () => {
  it('paints a 1px chebyshev ring around the alpha mask', () => {
    const T = [0, 0, 0, 0];
    const RED = [255, 0, 0, 255];
    const out = addOutline(
      img(3, 3, [T, T, T, T, RED, T, T, T, T]),
      { color: '#000000', thickness: 1 },
    );
    expect(px(out, 1, 1)).toEqual(RED); // sprite pixel untouched
    for (const [x, y] of [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]]) {
      expect(px(out, x, y)).toEqual([0, 0, 0, 255]);
    }
  });
});

describe('runPipeline', () => {
  it('dispatches ops in order and reports progress', () => {
    const input = img(2, 2, [
      [10, 10, 10, 255],
      [240, 240, 240, 255],
      [10, 10, 10, 60],
      [240, 240, 240, 200],
    ]);
    const notes: Array<[number, string]> = [];
    const out = runPipeline(
      input,
      [
        { op: 'alphaCleanup' },
        { op: 'quantize', colors: ['#000000', '#ffffff'] },
        { op: 'resize', mode: 'scale', factor: 2 },
      ],
      (i, note) => notes.push([i, note]),
    );
    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    expect(notes.map(([i]) => i)).toEqual([0, 1, 2]);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(out, 0, 2)[3]).toBe(0); // alpha 60 -> cleaned to 0
  });
});
