/**
 * Pointer tool is pure navigation: dragging pans the viewport by screen-space
 * deltas and it NEVER writes pixels, selection or history — that's the whole
 * contract that makes it a safe default tool. Node environment — same
 * ImageData polyfill as brush-line.test.ts (the tool never touches canvas).
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
import { TOOLS } from '../index.js';
import { createPointerTool } from '../pointer-tool.js';
import type { ToolContext, ToolPointerEvent } from '../tool-types.js';

function makeCtx(w = 8, h = 8) {
  const doc = new EditorDocument(w, h);
  doc.addLayer('bg');
  const history = new History();
  const viewport = new Viewport();
  let invalidations = 0;
  const ctx: ToolContext = {
    doc,
    selection: new SelectionMask(w, h),
    history,
    viewport,
    options: { size: 1, softness: 0, tolerance: 0, contiguous: true, shape: 'square' },
    colors: { fg: '#ff0000', bg: '#ffffff' },
    invalidate: () => { invalidations++; },
    pickColor: () => {},
  };
  return { ctx, doc, history, viewport, invalidations: () => invalidations };
}

/** Screen-space event (imageX/Y irrelevant to the pointer tool). */
const ev = (sx: number, sy: number, buttons = 1): ToolPointerEvent => ({
  imageX: 0, imageY: 0, screenX: sx, screenY: sy, shift: false, alt: false, buttons,
});

describe('pointer tool', () => {
  it('pans the viewport by screen deltas across a drag and invalidates', () => {
    const tool = createPointerTool();
    const { ctx, viewport, invalidations } = makeCtx();
    tool.onDown(ev(10, 10), ctx);
    tool.onMove(ev(25, 18), ctx);
    expect(viewport.panX).toBe(15);
    expect(viewport.panY).toBe(8);
    tool.onMove(ev(30, 15), ctx); // deltas accumulate from the LAST position
    expect(viewport.panX).toBe(20);
    expect(viewport.panY).toBe(5);
    expect(viewport.zoom).toBe(1); // pan only — never zooms
    expect(invalidations()).toBe(2);
    tool.onUp(ev(30, 15), ctx);
  });

  it('never writes history, pixels or selection', () => {
    const tool = createPointerTool();
    const { ctx, doc, history } = makeCtx();
    tool.onDown(ev(2, 2), ctx);
    tool.onMove(ev(6, 7), ctx);
    tool.onUp(ev(6, 7), ctx);
    expect(history.length).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(ctx.selection.isEmpty()).toBe(true);
    const data = doc.activeLayer!.imageData.data;
    expect(data.every((b) => b === 0)).toBe(true); // no accidental paint
  });

  it('ignores moves before onDown and without the primary button held', () => {
    const tool = createPointerTool();
    const { ctx, viewport } = makeCtx();
    tool.onMove(ev(50, 50), ctx); // no gesture yet
    expect(viewport.panX).toBe(0);
    tool.onDown(ev(0, 0), ctx);
    tool.onMove(ev(9, 9, 0), ctx); // button released mid-gesture
    expect(viewport.panX).toBe(0);
    expect(viewport.panY).toBe(0);
    tool.onUp(ev(9, 9, 0), ctx);
    tool.onMove(ev(20, 20), ctx); // gesture over — drag must not resume
    expect(viewport.panX).toBe(0);
  });

  it('is registered first in the tool registry with a neutral cursor', () => {
    expect(Object.keys(TOOLS)[0]).toBe('pointer');
    expect(TOOLS.pointer.id).toBe('pointer');
    expect(TOOLS.pointer.cursor).toBe('default');
  });
});
