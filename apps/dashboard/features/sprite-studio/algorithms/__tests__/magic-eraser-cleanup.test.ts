import { describe, expect, it } from 'vitest';
import { createRaster, setPixel } from '../image-data.js';
import { cleanupMagicEraserMask } from '../magic-eraser-cleanup.js';

const maskValues = (mask: Uint8Array) => Array.from(mask);

describe('cleanupMagicEraserMask', () => {
  it('expands into background-colored fringe while preserving subject pixels', () => {
    const raster = createRaster(5, 1);
    setPixel(raster, 0, 0, [30, 30, 30, 255]);
    setPixel(raster, 1, 0, [30, 30, 30, 255]);
    setPixel(raster, 2, 0, [38, 38, 38, 255]);
    setPixel(raster, 3, 0, [210, 160, 80, 255]);
    setPixel(raster, 4, 0, [210, 160, 80, 255]);

    const out = cleanupMagicEraserMask(raster, new Uint8Array([1, 1, 0, 0, 0]), { tolerance: 0, radius: 1 });

    expect(maskValues(out)).toEqual([1, 1, 1, 0, 0]);
  });

  it('keeps the original mask content when radius is disabled', () => {
    const raster = createRaster(3, 1);
    setPixel(raster, 0, 0, [20, 20, 20, 255]);
    setPixel(raster, 1, 0, [22, 22, 22, 255]);
    setPixel(raster, 2, 0, [200, 80, 40, 255]);

    const out = cleanupMagicEraserMask(raster, new Uint8Array([1, 0, 0]), { tolerance: 0, radius: 0 });

    expect(maskValues(out)).toEqual([1, 0, 0]);
  });

  it('honors canErase clipping for cleanup pixels', () => {
    const raster = createRaster(3, 1);
    setPixel(raster, 0, 0, [20, 20, 20, 255]);
    setPixel(raster, 1, 0, [22, 22, 22, 255]);
    setPixel(raster, 2, 0, [200, 80, 40, 255]);

    const out = cleanupMagicEraserMask(raster, new Uint8Array([1, 0, 0]), {
      tolerance: 0,
      radius: 1,
      canErase: (x) => x !== 1,
    });

    expect(maskValues(out)).toEqual([1, 0, 0]);
  });
});
