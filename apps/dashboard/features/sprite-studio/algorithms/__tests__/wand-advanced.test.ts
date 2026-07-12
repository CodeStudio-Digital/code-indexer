import { describe, expect, it } from 'vitest';
import { floodFillMask } from '../flood-fill.js';

const raster = (pixels: number[][]) => ({
  width: pixels.length, height: 1,
  data: new Uint8ClampedArray(pixels.flat()),
});

describe('advanced wand matching', () => {
  it('can select by alpha independent of RGB', () => {
    const mask = floodFillMask(raster([[255, 0, 0, 0], [0, 255, 0, 0], [0, 0, 255, 255]]), 0, 0, {
      matchMode: 'alpha', contiguous: false, tolerance: 0,
    });
    expect([...mask]).toEqual([1, 1, 0]);
  });

  it('perceptual mode groups close colors but preserves exact tolerance zero', () => {
    const input = raster([[100, 100, 100, 255], [104, 101, 99, 255], [180, 20, 20, 255]]);
    expect([...floodFillMask(input, 0, 0, { contiguous: false, tolerance: 12, colorMetric: 'perceptual' })]).toEqual([1, 1, 0]);
    expect([...floodFillMask(input, 0, 0, { contiguous: false, tolerance: 0, colorMetric: 'perceptual' })]).toEqual([1, 0, 0]);
  });
});
