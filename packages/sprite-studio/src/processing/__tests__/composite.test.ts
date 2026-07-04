/**
 * compositeLayers — straight-alpha source-over, bottom-up. Exact blend
 * values, single-layer identity, opaque shortcut, dimension-mismatch throw.
 */
import { describe, it, expect } from 'vitest';
import { compositeLayers, transparentImage } from '../composite.js';
import type { RgbaImage } from '../types.js';

const px = (r: number, g: number, b: number, a: number): RgbaImage => ({
  rgba: new Uint8Array([r, g, b, a]), width: 1, height: 1,
});

describe('compositeLayers', () => {
  it('single layer is an identity copy (not the same buffer)', () => {
    const base = px(10, 20, 30, 200);
    const out = compositeLayers([base]);
    expect([...out.rgba]).toEqual([10, 20, 30, 200]);
    expect(out.rgba).not.toBe(base.rgba);
  });

  it('opaque top layer fully replaces', () => {
    const out = compositeLayers([px(255, 0, 0, 255), px(0, 255, 0, 255)]);
    expect([...out.rgba]).toEqual([0, 255, 0, 255]);
  });

  it('50% top over opaque bottom = exact source-over blend', () => {
    const out = compositeLayers([px(0, 0, 0, 255), px(255, 255, 255, 128)]);
    // a=128/255≈0.502 → out = 255*0.502 + 0*0.498 ≈ 128; alpha stays 255.
    expect(out.rgba[0]).toBe(128);
    expect(out.rgba[3]).toBe(255);
  });

  it('transparent top pixel leaves the bottom untouched', () => {
    const out = compositeLayers([px(9, 9, 9, 90), px(0, 0, 0, 0)]);
    expect([...out.rgba]).toEqual([9, 9, 9, 90]);
  });

  it('throws layer_size_mismatch on diverging dims', () => {
    const big: RgbaImage = { rgba: new Uint8Array(2 * 1 * 4), width: 2, height: 1 };
    expect(() => compositeLayers([px(0, 0, 0, 255), big])).toThrow(/layer_size_mismatch/);
  });

  it('transparentImage is all zeroes at the requested dims', () => {
    const img = transparentImage(3, 2);
    expect(img.width).toBe(3);
    expect(img.rgba.every((v) => v === 0)).toBe(true);
  });
});
