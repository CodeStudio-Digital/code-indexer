/**
 * deleteSelection (Delete/Backspace shortcut core): clears the selected
 * pixels of the active layer to transparent as ONE undoable snapshot command.
 * Node environment with the ImageData polyfill (no canvas APIs touched — the
 * engine render loop is never started).
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

import { EditorEngine } from '../../engine/EditorEngine.js';
import { deleteSelection } from '../useEditorShortcuts.js';

/** Solid-color ImageData via the (polyfilled) global. */
function mk(w: number, h: number, rgba: [number, number, number, number]): ImageData {
  const img = new ImageData(w, h);
  for (let p = 0; p < w * h; p++) img.data.set(rgba, p * 4);
  return img;
}

const alphaAt = (engine: EditorEngine, x: number, y: number) =>
  engine.doc.activeLayer!.imageData.data[(y * engine.doc.width + x) * 4 + 3];

describe('deleteSelection', () => {
  it('no-ops without a selection or without a layer', () => {
    const engine = new EditorEngine(4, 4);
    expect(deleteSelection(engine)).toBe(false); // no layer

    engine.doc.addLayer('bg', mk(4, 4, [9, 9, 9, 255]));
    expect(deleteSelection(engine)).toBe(false); // no selection
    expect(engine.history.canUndo).toBe(false);

    engine.selection.setRect({ x: 0, y: 0, w: 2, h: 2 }, 'replace');
    engine.selection.setRect({ x: 0, y: 0, w: 2, h: 2 }, 'subtract'); // all-zero mask
    expect(deleteSelection(engine)).toBe(false); // empty mask
    expect(engine.history.canUndo).toBe(false);
  });

  it('zeroes alpha ONLY inside the mask and pushes one undoable command', () => {
    const engine = new EditorEngine(4, 4);
    engine.doc.addLayer('bg', mk(4, 4, [10, 20, 30, 255]));
    engine.selection.setRect({ x: 0, y: 0, w: 2, h: 2 }, 'replace');

    expect(deleteSelection(engine)).toBe(true);
    expect(alphaAt(engine, 0, 0)).toBe(0);
    expect(alphaAt(engine, 1, 1)).toBe(0);
    expect(alphaAt(engine, 2, 0)).toBe(255); // outside the marquee untouched
    expect(alphaAt(engine, 3, 3)).toBe(255);
    // RGB inside the mask is preserved — only alpha is cleared.
    expect(engine.doc.activeLayer!.imageData.data[0]).toBe(10);
    expect(engine.history.length).toBe(1);

    engine.undo();
    expect(alphaAt(engine, 0, 0)).toBe(255); // restored
    expect(engine.history.canRedo).toBe(true);

    engine.redo();
    expect(alphaAt(engine, 0, 0)).toBe(0);
    expect(alphaAt(engine, 3, 3)).toBe(255);
  });

  it('refuses a stale mask whose size disagrees with the layer', () => {
    const engine = new EditorEngine(4, 4);
    engine.doc.addLayer('bg', mk(4, 4, [1, 1, 1, 255]));
    engine.selection.setRect({ x: 0, y: 0, w: 4, h: 4 }, 'replace');
    // Simulate a desync: layer pixels swap under an un-resized mask.
    engine.doc.activeLayer!.imageData = mk(2, 2, [1, 1, 1, 255]);
    expect(deleteSelection(engine)).toBe(false);
    expect(engine.history.canUndo).toBe(false);
  });
});
