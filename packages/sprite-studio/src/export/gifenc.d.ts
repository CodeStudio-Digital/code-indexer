/**
 * Minimal ambient types for `gifenc` (pure-JS GIF encoder, ships no .d.ts).
 * Only the surface gif.ts uses is declared — see the package README for the
 * full API (github.com/mattdesl/gifenc).
 */
declare module 'gifenc' {
  /** Palette entry: [r,g,b] or [r,g,b,a] depending on the quantize format. */
  export type GifPaletteEntry = number[];

  export interface GifWriteFrameOpts {
    palette?: GifPaletteEntry[];
    /** Frame delay in MILLISECONDS (encoded as centiseconds internally). */
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    /** GIF disposal method; 2 = restore to background (needed for alpha). */
    dispose?: number;
    /** Loop count written with the first frame: 0 = forever, -1 = play once. */
    repeat?: number;
    first?: boolean;
  }

  export interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: GifWriteFrameOpts): void;
    finish(): void;
    bytes(): Uint8Array;
    reset(): void;
  }

  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance;

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: { format?: 'rgb565' | 'rgb444' | 'rgba4444'; oneBitAlpha?: boolean | number; clearAlpha?: boolean },
  ): GifPaletteEntry[];

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: GifPaletteEntry[],
    format?: 'rgb565' | 'rgb444' | 'rgba4444',
  ): Uint8Array;
}
