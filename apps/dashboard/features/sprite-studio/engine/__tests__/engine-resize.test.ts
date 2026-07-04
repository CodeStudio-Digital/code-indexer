/**
 * Regression tests for the dimension-aware engine paths: document resizeTo /
 * snapshot-restore across dims, applyResizedActive undo/redo, loadFromImage
 * and selection resizing. Node environment — a minimal ImageData polyfill
 * stands in for the DOM class (these paths never touch canvas APIs; only the
 * render loop does, and it is never started here).
 */
import { describe, expect, it } from 'vitest';

class ImageDataPolyfill {
  readonly data: Uint8ClampedArray;
  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
  }
}
const g = globalThis as { ImageData?: unknown };
g.ImageData ??= ImageDataPolyfill;

import { EditorDocument } from '../document.js';
import { EditorEngine } from '../EditorEngine.js';
import { masksEqual, SelectionMask } from '../selection-mask.js';

/** Solid-color ImageData via the (polyfilled) global. */
function mk(w: number, h: number, rgba: [number, number, number, number]): ImageData {
  const img = new ImageData(w, h);
  for (let p = 0; p < w * h; p++) img.data.set(rgba, p * 4);
  return img;
}

const px = (img: ImageData, i = 0) => [...img.data.slice(i * 4, i * 4 + 4)];

describe('EditorDocument resize', () => {
  it('resizeTo changes dims and flatten() output follows', () => {
    const doc = new EditorDocument(8, 8);
    doc.addLayer('bg', mk(8, 8, [255, 0, 0, 255]));
    doc.resizeTo(16, 4);
    doc.activeLayer!.imageData = mk(16, 4, [0, 255, 0, 255]);
    expect(doc.width).toBe(16);
    expect(doc.height).toBe(4);
    const flat = doc.flatten();
    expect(flat.width).toBe(16);
    expect(flat.height).toBe(4);
    expect(px(flat)).toEqual([0, 255, 0, 255]);
  });

  it('snapshot → resizeTo → restore roundtrips dims AND pixels without throwing', () => {
    const doc = new EditorDocument(8, 8);
    const layer = doc.addLayer('bg', mk(8, 8, [10, 20, 30, 255]));
    const snap = doc.snapshot();
    doc.resizeTo(3, 3);
    layer.imageData = mk(3, 3, [0, 0, 0, 255]);
    // Old crash: restore() kept the new dims and data.set() across sizes threw.
    expect(() => doc.restore(snap)).not.toThrow();
    expect(doc.width).toBe(8);
    expect(doc.height).toBe(8);
    const img = doc.activeLayer!.imageData;
    expect(img.width).toBe(8);
    expect(img.data.length).toBe(8 * 8 * 4);
    expect(px(img)).toEqual([10, 20, 30, 255]);
    expect(px(img, 8 * 8 - 1)).toEqual([10, 20, 30, 255]);
  });
});

describe('EditorEngine.applyResizedActive', () => {
  it('commits an undoable resize on a single-layer doc; undo/redo shuttle dims + pixels', () => {
    const engine = new EditorEngine(4, 4);
    engine.doc.addLayer('Background', mk(4, 4, [200, 0, 0, 255]));

    expect(engine.applyResizedActive(mk(8, 8, [0, 0, 200, 255]), 'Upscale 2×')).toBe(true);
    expect(engine.doc.width).toBe(8);
    expect(engine.doc.height).toBe(8);
    expect(engine.selection.width).toBe(8); // selection coordinate space follows
    expect(engine.history.canUndo).toBe(true);

    engine.undo();
    expect(engine.doc.width).toBe(4);
    expect(engine.doc.height).toBe(4);
    expect(engine.selection.width).toBe(4); // undo across the resize boundary resizes it back
    expect(px(engine.doc.activeLayer!.imageData)).toEqual([200, 0, 0, 255]);

    engine.redo();
    expect(engine.doc.width).toBe(8);
    expect(engine.selection.width).toBe(8);
    expect(px(engine.doc.activeLayer!.imageData)).toEqual([0, 0, 200, 255]);
  });

  it('refuses on a multi-layer doc and leaves it untouched', () => {
    const engine = new EditorEngine(4, 4);
    engine.doc.addLayer('a', mk(4, 4, [1, 2, 3, 255]));
    engine.doc.addLayer('b', mk(4, 4, [9, 9, 9, 255]));

    expect(engine.applyResizedActive(mk(8, 8, [0, 0, 0, 255]), 'Upscale')).toBe(false);
    expect(engine.doc.width).toBe(4);
    expect(engine.doc.layers).toHaveLength(2);
    expect(engine.history.canUndo).toBe(false);
    expect(px(engine.doc.layers[0].imageData)).toEqual([1, 2, 3, 255]);
  });

  it('drops an active selection mask when dims change', () => {
    const engine = new EditorEngine(4, 4);
    engine.doc.addLayer('Background', mk(4, 4, [5, 5, 5, 255]));
    engine.selection.setRect({ x: 0, y: 0, w: 4, h: 4 }, 'replace');
    expect(engine.selection.isEmpty()).toBe(false);
    engine.applyResizedActive(mk(8, 8, [6, 6, 6, 255]), 'Upscale');
    expect(engine.selection.isEmpty()).toBe(true);
    expect(engine.selection.data).toBeNull();
  });
});

describe('EditorEngine.loadFromImage', () => {
  it('is dimension-aware: resets doc + selection dims, single layer, clears history', () => {
    const engine = new EditorEngine(4, 4);
    engine.doc.addLayer('old', mk(4, 4, [5, 5, 5, 255]));
    engine.applyResizedActive(mk(2, 2, [1, 1, 1, 255]), 'Crop'); // seed some history

    engine.loadFromImage(mk(16, 8, [7, 7, 7, 255]), 42);
    expect(engine.doc.width).toBe(16);
    expect(engine.doc.height).toBe(8);
    expect(engine.doc.layers).toHaveLength(1);
    expect(engine.selection.width).toBe(16);
    expect(engine.selection.height).toBe(8);
    expect(engine.loadedVersionId).toBe(42);
    expect(engine.history.canUndo).toBe(false);
    expect(px(engine.doc.activeLayer!.imageData)).toEqual([7, 7, 7, 255]);
  });
});

describe('SelectionMask.resize', () => {
  it('drops the mask and contains() uses the new bounds', () => {
    const sel = new SelectionMask(8, 8);
    sel.setRect({ x: 0, y: 0, w: 8, h: 8 }, 'replace');
    expect(sel.isEmpty()).toBe(false);

    sel.resize(16, 16);
    expect(sel.data).toBeNull();
    expect(sel.isEmpty()).toBe(true);

    sel.setRect({ x: 14, y: 14, w: 10, h: 10 }, 'replace'); // clamps to the NEW bounds
    expect(sel.data).toHaveLength(16 * 16);
    expect(sel.contains(15, 15)).toBe(true);
    expect(sel.contains(13, 13)).toBe(false);

    sel.resize(16, 16); // same dims → no-op, mask survives
    expect(sel.isEmpty()).toBe(false);
  });
});

describe('masksEqual', () => {
  it('treats null and all-zero masks as the same "no selection"', () => {
    expect(masksEqual(null, null)).toBe(true);
    expect(masksEqual(null, new Uint8Array(4))).toBe(true);
    expect(masksEqual(new Uint8Array(4), null)).toBe(true);
  });

  it('compares real masks byte-wise', () => {
    const a = new Uint8Array([0, 1, 0, 0]);
    expect(masksEqual(a, new Uint8Array([0, 1, 0, 0]))).toBe(true);
    expect(masksEqual(a, null)).toBe(false);
    expect(masksEqual(a, new Uint8Array([1, 1, 0, 0]))).toBe(false);
    expect(masksEqual(a, new Uint8Array([0, 1]))).toBe(false);
  });
});
