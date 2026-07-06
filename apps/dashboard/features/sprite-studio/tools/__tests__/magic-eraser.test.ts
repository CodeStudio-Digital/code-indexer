/**
 * Magic eraser: one click flood-clears the contiguous color region's ALPHA
 * (RGB preserved), honors tolerance/contiguous, clips by selection, and
 * commits exactly one undoable command.
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

import { EditorDocument } from '../../engine/document.js';
import { History } from '../../engine/history.js';
import { SelectionMask } from '../../engine/selection-mask.js';
import { Viewport } from '../../engine/viewport.js';
import { createFillTool } from '../fill-tool.js';
import type { ToolContext, ToolPointerEvent } from '../tool-types.js';

function makeCtx(w = 6, h = 6) {
  const doc = new EditorDocument(w, h);
  doc.addLayer('bg');
  const history = new History();
  const ctx: ToolContext = {
    doc,
    selection: new SelectionMask(w, h),
    history,
    viewport: new Viewport(),
    options: { size: 1, softness: 0, tolerance: 0, contiguous: true, shape: 'square' },
    colors: { fg: '#00ff00', bg: '#ffffff' },
    invalidate: () => {},
    pickColor: () => {},
  };
  return { ctx, doc, history };
}

const ev = (x: number, y: number): ToolPointerEvent => ({
  imageX: x, imageY: y, screenX: 0, screenY: 0, shift: false, alt: false, buttons: 1,
});

/** Paint pixel (x,y) = rgba. */
function set(doc: EditorDocument, x: number, y: number, rgba: [number, number, number, number]) {
  const d = doc.activeLayer!.imageData.data;
  const i = (y * doc.width + x) * 4;
  [d[i], d[i + 1], d[i + 2], d[i + 3]] = rgba;
}
const at = (doc: EditorDocument, x: number, y: number) => {
  const d = doc.activeLayer!.imageData.data;
  const i = (y * doc.width + x) * 4;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
};

describe('magic eraser', () => {
  it('clears the contiguous region alpha, preserving RGB and other regions', () => {
    const tool = createFillTool('magic-eraser');
    const { ctx, doc } = makeCtx();
    // A 2x2 red island at (0,0) and a separate red pixel at (4,4).
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) set(doc, x, y, [255, 0, 0, 255]);
    set(doc, 4, 4, [255, 0, 0, 255]);
    tool.onDown(ev(0, 0), ctx);
    expect(at(doc, 0, 0)).toEqual([255, 0, 0, 0]); // alpha dead, RGB intact
    expect(at(doc, 1, 1)[3]).toBe(0);
    expect(at(doc, 4, 4)[3]).toBe(255); // disconnected island untouched
  });

  it('contiguous=false clears ALL matching pixels', () => {
    const tool = createFillTool('magic-eraser');
    const { ctx, doc } = makeCtx();
    ctx.options.contiguous = false;
    set(doc, 0, 0, [255, 0, 0, 255]);
    set(doc, 4, 4, [255, 0, 0, 255]);
    tool.onDown(ev(0, 0), ctx);
    expect(at(doc, 0, 0)[3]).toBe(0);
    expect(at(doc, 4, 4)[3]).toBe(0);
  });

  it('cleans a near-background fringe pixel without eating the subject', () => {
    const tool = createFillTool('magic-eraser');
    const { ctx, doc } = makeCtx();
    ctx.options.edgeCleanup = 1;
    set(doc, 0, 0, [30, 30, 30, 255]);
    set(doc, 1, 0, [30, 30, 30, 255]);
    set(doc, 2, 0, [37, 37, 37, 255]); // anti-aliased background fringe
    set(doc, 3, 0, [220, 150, 80, 255]); // subject body

    tool.onDown(ev(0, 0), ctx);

    expect(at(doc, 0, 0)[3]).toBe(0);
    expect(at(doc, 2, 0)[3]).toBe(0);
    expect(at(doc, 3, 0)[3]).toBe(255);
  });

  it('edge cleanup can be disabled for exact legacy flood behavior', () => {
    const tool = createFillTool('magic-eraser');
    const { ctx, doc } = makeCtx();
    ctx.options.edgeCleanup = 0;
    set(doc, 0, 0, [30, 30, 30, 255]);
    set(doc, 1, 0, [30, 30, 30, 255]);
    set(doc, 2, 0, [37, 37, 37, 255]);

    tool.onDown(ev(0, 0), ctx);

    expect(at(doc, 0, 0)[3]).toBe(0);
    expect(at(doc, 2, 0)[3]).toBe(255);
  });

  it('selection clips the erase and it is one undoable command', () => {
    const tool = createFillTool('magic-eraser');
    const { ctx, doc, history } = makeCtx();
    for (let x = 0; x < 4; x++) set(doc, x, 0, [255, 0, 0, 255]);
    ctx.selection.setRect({ x: 0, y: 0, w: 2, h: 1 }, 'replace');
    tool.onDown(ev(0, 0), ctx);
    expect(at(doc, 1, 0)[3]).toBe(0);
    expect(at(doc, 2, 0)[3]).toBe(255); // outside selection
    expect(history.length).toBe(1);
  });

  it('selection also clips edge-cleanup fringe pixels', () => {
    const tool = createFillTool('magic-eraser');
    const { ctx, doc } = makeCtx();
    ctx.options.edgeCleanup = 1;
    ctx.selection.setRect({ x: 0, y: 0, w: 2, h: 1 }, 'replace');
    set(doc, 0, 0, [30, 30, 30, 255]);
    set(doc, 1, 0, [30, 30, 30, 255]);
    set(doc, 2, 0, [37, 37, 37, 255]); // would clean if not clipped

    tool.onDown(ev(0, 0), ctx);

    expect(at(doc, 1, 0)[3]).toBe(0);
    expect(at(doc, 2, 0)[3]).toBe(255);
  });

  it('undo captures cleanup pixels that cross a tile boundary', () => {
    const tool = createFillTool('magic-eraser');
    const { ctx, doc, history } = makeCtx(66, 1);
    ctx.options.edgeCleanup = 1;
    set(doc, 62, 0, [30, 30, 30, 255]);
    set(doc, 63, 0, [30, 30, 30, 255]);
    set(doc, 64, 0, [37, 37, 37, 255]); // cleanup crosses into tile 1
    set(doc, 65, 0, [220, 150, 80, 255]);

    tool.onDown(ev(62, 0), ctx);

    const cmd = history.undo();
    expect(cmd?.kind).toBe('tiles');
    if (cmd?.kind !== 'tiles') throw new Error('expected tiles command');
    expect(cmd.before.map((t) => t.tx).sort()).toEqual([0, 1]);
  });

  it('fill kind still paints fg (regression)', () => {
    const tool = createFillTool('fill');
    const { ctx, doc } = makeCtx();
    tool.onDown(ev(2, 2), ctx); // whole transparent canvas floods
    expect(at(doc, 0, 0)).toEqual([0, 255, 0, 255]);
  });
});
