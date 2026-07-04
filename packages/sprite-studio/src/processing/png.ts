import { PNG } from 'pngjs';
import type { RgbaImage } from './types.js';

/** PNG magic: 89 50 4E 47 0D 0A 1A 0A. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from('IEND', 'ascii');

/**
 * Trim a PNG buffer to the end of its IEND chunk. Some image sources (a few
 * AI-image backends, CDN re-encoders) append trailing bytes after IEND, which
 * makes pngjs's strict sync reader throw "unrecognised content at end of
 * stream". IEND carries a zero-length payload, so the stream ends 8 bytes past
 * the 'IEND' type marker (4 type + 4 CRC).
 */
function sanitizePngBuffer(buf: Buffer): Buffer {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('decodePng: buffer is not a PNG (bad signature)');
  }
  const iendType = buf.lastIndexOf(IEND);
  if (iendType < 0) return buf; // no IEND found — let pngjs surface the real error
  const end = iendType + IEND.length + 4; // + CRC
  return end < buf.length ? buf.subarray(0, end) : buf;
}

/** Decode a PNG buffer into a plain RGBA8 bitmap (always 8-bit RGBA out). */
export function decodePng(buffer: Buffer | Uint8Array): RgbaImage {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const png = PNG.sync.read(sanitizePngBuffer(buf));
  return {
    rgba: new Uint8Array(png.data), // copy: detach from pngjs internals
    width: png.width,
    height: png.height,
  };
}

/** Encode an RGBA8 bitmap as a PNG buffer. */
export function encodePng(img: RgbaImage): Buffer {
  const expected = img.width * img.height * 4;
  if (img.rgba.length !== expected) {
    throw new Error(
      `RGBA byte length ${img.rgba.length} does not match ${img.width}x${img.height} (expected ${expected})`,
    );
  }
  const png = new PNG({ width: img.width, height: img.height });
  png.data.set(img.rgba);
  return PNG.sync.write(png);
}
