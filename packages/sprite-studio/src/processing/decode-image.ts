/**
 * Format-sniffing image decode → RGBA8. The generation pipeline cannot assume
 * PNG: image backends return what they like (Gemini/Workers AI frequently emit
 * JPEG; WebP exists in the wild), and repo-imported assets may reference any
 * file. Magic bytes decide the decoder; unknown formats fail with an
 * actionable message that names what actually arrived instead of pngjs's
 * cryptic "bad signature".
 */
import { decode as decodeJpeg } from 'jpeg-js';
import { decodePng } from './png.js';
import type { RgbaImage } from './types.js';

export type SniffedFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'unknown';

/** Identify an image buffer by magic bytes (cheap, no decoding). */
export function sniffImageFormat(buf: Uint8Array): SniffedFormat {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 // WEBP
  ) return 'webp';
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return 'unknown';
}

/**
 * Strip a `data:<mime>;base64,` prefix when a backend hands back a data URI
 * instead of raw base64 (defensive: Buffer.from would decode the prefix as
 * garbage bytes and every signature check downstream would fail).
 */
export function stripDataUriPrefix(base64: string): string {
  if (!base64.startsWith('data:')) return base64;
  const comma = base64.indexOf(',');
  return comma >= 0 ? base64.slice(comma + 1) : base64;
}

/** Decode PNG or JPEG into RGBA8; other formats throw with a clear message. */
export function decodeImage(buffer: Buffer | Uint8Array): RgbaImage {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const format = sniffImageFormat(buf);
  switch (format) {
    case 'png':
      return decodePng(buf);
    case 'jpeg': {
      const jpg = decodeJpeg(buf, { useTArray: true, formatAsRGBA: true });
      return { rgba: new Uint8Array(jpg.data), width: jpg.width, height: jpg.height };
    }
    case 'webp':
    case 'gif':
    case 'bmp':
      throw new Error(
        `decodeImage: ${format.toUpperCase()} is not supported by the sprite pipeline yet — ` +
          `use a model/output that emits PNG or JPEG`,
      );
    default: {
      const head = Buffer.from(buf.subarray(0, 12)).toString('hex').replace(/(..)/g, '$1 ').trim();
      const asText = Buffer.from(buf.subarray(0, 80)).toString('utf8').replace(/[^\x20-\x7e]/g, '.');
      throw new Error(
        `decodeImage: unrecognized image data (magic: ${head || 'empty'}; as text: "${asText}") — ` +
          `the backend likely returned an error payload instead of an image`,
      );
    }
  }
}
