/**
 * Shape tools: nothing painted during the drag (preview only), one undoable
 * command on pointer-up, pixel-exact rasterization (Bresenham line, rect
 * outline, 4-way symmetric ellipse), fill clipped by selection, shift
 * constrains, and setShapePreview is published on move and cleared on up.
 */
import { describe, expect, it, vi } from 'vitest';

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
import { constrain, ellipseOutlinePoints, rectOutlinePoints } from '../../algorithms/shape-raster.js';
import { createShapeTool } from '../shape-tools.js';
import type { ShapePreview, ToolContext, ToolPointerEvent } from '../tool-types.js';

function makeCtx(w = 12, h = 12) {
  const doc = new EditorDocument(w, h);
  doc.addLayer('bg');
  const history = new History();
  const setShapePreview = vi.fn<(p: ShapePreview | null) => void>();
  const ctx: ToolContext = {
    doc,
    selection: new SelectionMask(w, h),
    history,
    viewport: new Viewport(),
    options: { size: 1, softness: 0, tolerance: 0, contiguous: true, shape: 'square' },
    colors: { fg: '#0000ff', bg: '#ffffff' },
    invalidate: () => {},
    pickColor: () => {},
    setShapePreview,
  };
  return { ctx, doc, history, setShapePreview };
}

const ev = (x: number, y: number, shift = false): ToolPointerEvent => ({
  imageX: x, imageY: y, screenX: 0, screenY: 0, shift, alt: false, buttons: 1,
});

const alphaAt = (doc: EditorDocument, x: number, y: number) =>
  doc.activeLayer!.imageData.data[(y * doc.width + x) * 4 + 3];

describe('line tool', () => {
  it('paints nothing during the drag; commits ONE command on up', () => {
    const tool = createShapeTool('line');
    const { ctx, doc, history, setShapePreview } = makeCtx();
    tool.onDown(ev(0, 0), ctx);
    tool.onMove(ev(4, 0), ctx);
    expect(alphaAt(doc, 2, 0)).toBe(0); // still preview-only
    expect(setShapePreview).toHaveBeenCalled();
    tool.onUp(ev(4, 0), ctx);
    for (let x = 0; x <= 4; x++) expect(alphaAt(doc, x, 0)).toBe(255);
    expect(history.length).toBe(1);
    expect(setShapePreview).toHaveBeenLastCalledWith(null);
  });

  it('shift constrains to 45°', () => {
    expect(constrain('line', 0, 0, 5, 4)).toEqual({ x: 5, y: 5 });
    expect(constrain('line', 0, 0, 9, 1)).toEqual({ x: 9, y: 0 });
    expect(constrain('line', 0, 0, 1, 9)).toEqual({ x: 0, y: 9 });
  });
});

describe('rect tool', () => {
  it('outline is exactly the perimeter', () => {
    const tool = createShapeTool('rect');
    const { ctx, doc } = makeCtx();
    tool.onDown(ev(1, 1), ctx);
    tool.onMove(ev(4, 3), ctx);
    tool.onUp(ev(4, 3), ctx);
    for (let x = 1; x <= 4; x++) {
      expect(alphaAt(doc, x, 1)).toBe(255);
      expect(alphaAt(doc, x, 3)).toBe(255);
    }
    expect(alphaAt(doc, 1, 2)).toBe(255);
    expect(alphaAt(doc, 4, 2)).toBe(255);
    expect(alphaAt(doc, 2, 2)).toBe(0); // interior empty
  });

  it('fill paints the interior, clipped by selection', () => {
    const tool = createShapeTool('rect');
    const { ctx, doc } = makeCtx();
    ctx.options.shapeFill = true;
    ctx.selection.setRect({ x: 0, y: 0, w: 3, h: 12 }, 'replace');
    tool.onDown(ev(1, 1), ctx);
    tool.onUp(ev(5, 4), ctx);
    expect(alphaAt(doc, 2, 2)).toBe(255); // inside selection
    expect(alphaAt(doc, 4, 2)).toBe(0);   // outside selection
  });

  it('rectOutlinePoints has no duplicates', () => {
    const pts = rectOutlinePoints(0, 0, 3, 2);
    const keys = new Set(pts.map((p) => `${p.x}:${p.y}`));
    expect(keys.size).toBe(pts.length);
    expect(keys.size).toBe(10); // 4+4 top/bottom + 2 sides
  });
});

describe('ellipse tool', () => {
  it('outline is 4-way symmetric around the box center', () => {
    const pts = ellipseOutlinePoints(0, 0, 8, 6);
    const has = (x: number, y: number) => pts.some((p) => p.x === x && p.y === y);
    for (const p of pts) {
      expect(has(8 - p.x, p.y)).toBe(true);  // mirror X
      expect(has(p.x, 6 - p.y)).toBe(true);  // mirror Y
    }
    expect(has(4, 0)).toBe(true); // extremes present
    expect(has(0, 3)).toBe(true);
  });

  it('commits on up as one command', () => {
    const tool = createShapeTool('ellipse');
    const { ctx, doc, history } = makeCtx();
    tool.onDown(ev(1, 1), ctx);
    tool.onUp(ev(9, 7), ctx);
    expect(history.length).toBe(1);
    expect(alphaAt(doc, 5, 1)).toBe(255); // top extreme
  });
});
