/**
 * Shift+line brush behavior: shift+click connects a Bresenham line from the
 * last stamp of the PREVIOUS stroke, coalesced into ONE undoable command, and
 * never bleeds across documents. Node environment — same ImageData polyfill
 * as engine-resize.test.ts (the brush never touches canvas APIs).
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
import { applyTiles } from '../../engine/tile-diff.js';
import { Viewport } from '../../engine/viewport.js';
import { createBrushTool } from '../brush-tool.js';
import type { ToolContext, ToolPointerEvent } from '../tool-types.js';

function makeCtx(w = 8, h = 8): { ctx: ToolContext; doc: EditorDocument; history: History } {
  const doc = new EditorDocument(w, h);
  doc.addLayer('bg');
  const history = new History();
  const ctx: ToolContext = {
    doc,
    selection: new SelectionMask(w, h),
    history,
    viewport: new Viewport(),
    options: { size: 1, softness: 0, tolerance: 0, contiguous: true, shape: 'square' },
    colors: { fg: '#ff0000', bg: '#ffffff' },
    invalidate: () => {},
    pickColor: () => {},
  };
  return { ctx, doc, history };
}

const ev = (x: number, y: number, shift = false): ToolPointerEvent => ({
  imageX: x, imageY: y, screenX: 0, screenY: 0, shift, alt: false, buttons: 1,
});

const alphaAt = (doc: EditorDocument, x: number, y: number) =>
  doc.activeLayer!.imageData.data[(y * doc.width + x) * 4 + 3];

/** Click (down+up) at (x,y). */
function click(tool: ReturnType<typeof createBrushTool>, ctx: ToolContext, x: number, y: number, shift = false) {
  tool.onDown(ev(x, y, shift), ctx);
  tool.onUp(ev(x, y, shift), ctx);
}

describe('brush shift+line', () => {
  it('connects a line from the previous stroke as ONE undoable command', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc, history } = makeCtx();

    click(tool, ctx, 0, 0);
    expect(history.length).toBe(1);
    expect(alphaAt(doc, 0, 0)).toBe(255);
    expect(alphaAt(doc, 1, 0)).toBe(0);

    click(tool, ctx, 4, 0, true); // shift → line (0,0)→(4,0)
    for (let x = 0; x <= 4; x++) expect(alphaAt(doc, x, 0)).toBe(255);
    expect(history.length).toBe(2); // the whole line is one command

    // Undoing that one command removes the entire line but keeps stroke #1.
    const cmd = history.undo();
    expect(cmd?.kind).toBe('tiles');
    if (cmd?.kind === 'tiles') applyTiles(doc.activeLayer!.imageData, cmd.before);
    expect(alphaAt(doc, 0, 0)).toBe(255);
    for (let x = 1; x <= 4; x++) expect(alphaAt(doc, x, 0)).toBe(0);
  });

  it('stamps diagonal Bresenham lines', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc } = makeCtx();
    click(tool, ctx, 0, 0);
    click(tool, ctx, 3, 3, true);
    for (let i = 0; i <= 3; i++) expect(alphaAt(doc, i, i)).toBe(255);
    expect(alphaAt(doc, 1, 0)).toBe(0);
  });

  it('plain click does NOT connect; lastPoint advances every stroke', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc, history } = makeCtx();
    click(tool, ctx, 0, 0);
    click(tool, ctx, 4, 0); // no shift
    expect(alphaAt(doc, 4, 0)).toBe(255);
    for (let x = 1; x <= 3; x++) expect(alphaAt(doc, x, 0)).toBe(0);

    click(tool, ctx, 6, 0, true); // shift connects from (4,0), not (0,0)
    expect(alphaAt(doc, 5, 0)).toBe(255);
    expect(alphaAt(doc, 3, 0)).toBe(0);
    expect(history.length).toBe(3);
  });

  it('shift+click with no previous stroke stamps a single point', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc } = makeCtx();
    click(tool, ctx, 3, 3, true);
    expect(alphaAt(doc, 3, 3)).toBe(255);
    expect(alphaAt(doc, 2, 2)).toBe(0);
    expect(alphaAt(doc, 2, 3)).toBe(0);
  });

  it('never connects across documents', () => {
    const tool = createBrushTool('brush');
    const a = makeCtx();
    const b = makeCtx();
    click(tool, a.ctx, 0, 0);
    click(tool, b.ctx, 4, 0, true); // different doc → plain stamp
    expect(alphaAt(b.doc, 4, 0)).toBe(255);
    for (let x = 0; x <= 3; x++) expect(alphaAt(b.doc, x, 0)).toBe(0);
  });

  it('eraser shift+line clears along the line', () => {
    const tool = createBrushTool('eraser');
    const { ctx, doc } = makeCtx();
    doc.activeLayer!.imageData.data.fill(255); // start fully opaque
    click(tool, ctx, 0, 0);
    click(tool, ctx, 3, 0, true);
    for (let x = 0; x <= 3; x++) expect(alphaAt(doc, x, 0)).toBe(0);
    expect(alphaAt(doc, 0, 1)).toBe(255);
  });
});
