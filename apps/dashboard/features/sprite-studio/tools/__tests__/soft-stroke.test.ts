/**
 * Soft-brush coverage-per-stroke semantics (PS Opacity): one drag never
 * saturates past opacity (coverage max), NEW strokes accumulate 1-(1-o)^n,
 * hard default path is byte-identical to the legacy writer, soft eraser is
 * proportional, selection clips, mirrorX doubles inside one command.
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
import { softWeight } from '../soft-stroke.js';
import type { ToolContext, ToolOptions, ToolPointerEvent } from '../tool-types.js';

function makeCtx(w = 8, h = 8, options: Partial<ToolOptions> = {}) {
  const doc = new EditorDocument(w, h);
  doc.addLayer('bg');
  const history = new History();
  const ctx: ToolContext = {
    doc,
    selection: new SelectionMask(w, h),
    history,
    viewport: new Viewport(),
    options: { size: 1, softness: 0, tolerance: 0, contiguous: true, shape: 'square', ...options },
    colors: { fg: '#ff0000', bg: '#ffffff' },
    invalidate: () => {},
    pickColor: () => {},
  };
  return { ctx, doc, history };
}

const ev = (x: number, y: number): ToolPointerEvent => ({
  imageX: x, imageY: y, screenX: 0, screenY: 0, shift: false, alt: false, buttons: 1,
});

const px = (doc: EditorDocument, x: number, y: number) => {
  const i = (y * doc.width + x) * 4;
  const d = doc.activeLayer!.imageData.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]] as const;
};

describe('softWeight (PS hardness falloff)', () => {
  it('is 1 inside the hard core and 0 at the rim', () => {
    expect(softWeight(0, 50)).toBe(1);
    expect(softWeight(0.5, 50)).toBe(1); // core radius = 1 - 50/100 = 0.5
    expect(softWeight(1, 50)).toBe(0);
    expect(softWeight(0.75, 50)).toBeGreaterThan(0);
    expect(softWeight(0.75, 50)).toBeLessThan(1);
  });
  it('softness 0 = hard everywhere inside', () => {
    expect(softWeight(0.99, 0)).toBe(1);
  });
});

describe('soft brush — coverage per stroke', () => {
  it('back-and-forth in ONE stroke caps alpha at opacity (never stacks)', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc } = makeCtx(8, 8, { opacity: 40 });
    tool.onDown(ev(1, 1), ctx);
    tool.onMove(ev(4, 1), ctx);
    tool.onMove(ev(1, 1), ctx); // retrace over the same pixels
    tool.onMove(ev(4, 1), ctx);
    tool.onUp(ev(4, 1), ctx);
    const a = px(doc, 2, 1)[3];
    expect(a).toBe(Math.round(255 * 0.4)); // exactly one pass worth
  });

  it('a SECOND stroke builds up: 1-(1-o)^2', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc } = makeCtx(8, 8, { opacity: 40 });
    tool.onDown(ev(2, 2), ctx);
    tool.onUp(ev(2, 2), ctx);
    tool.onDown(ev(2, 2), ctx);
    tool.onUp(ev(2, 2), ctx);
    const expected = Math.round(255 * (1 - 0.6 * 0.6)); // 64%
    expect(Math.abs(px(doc, 2, 2)[3] - expected)).toBeLessThanOrEqual(2); // rounding
  });

  it('paints pure fg color over transparent (no dark halo)', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc } = makeCtx(8, 8, { opacity: 50 });
    tool.onDown(ev(3, 3), ctx);
    tool.onUp(ev(3, 3), ctx);
    const [r, g2, b, a] = px(doc, 3, 3);
    expect([r, g2, b]).toEqual([255, 0, 0]); // fg RGB exact, not lerped to black
    expect(a).toBe(Math.round(255 * 0.5));
  });

  it('hard default path stays byte-identical (opaque overwrite)', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc } = makeCtx();
    tool.onDown(ev(0, 0), ctx);
    tool.onUp(ev(0, 0), ctx);
    expect(px(doc, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('soft eraser scales alpha down proportionally', () => {
    const tool = createBrushTool('eraser');
    const { ctx, doc } = makeCtx(8, 8, { opacity: 50 });
    doc.activeLayer!.imageData.data.fill(200);
    tool.onDown(ev(2, 2), ctx);
    tool.onUp(ev(2, 2), ctx);
    expect(px(doc, 2, 2)[3]).toBe(100); // 200 * (1 - 0.5)
    expect(px(doc, 4, 4)[3]).toBe(200); // untouched
  });

  it('selection clips soft stamps', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc } = makeCtx(8, 8, { opacity: 50, size: 3 });
    ctx.selection.setRect({ x: 0, y: 0, w: 2, h: 8 }, 'replace');
    tool.onDown(ev(1, 1), ctx);
    tool.onUp(ev(1, 1), ctx);
    expect(px(doc, 1, 1)[3]).toBeGreaterThan(0);
    expect(px(doc, 2, 1)[3]).toBe(0); // outside selection
  });

  it('one soft stroke = ONE undoable tiles command', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc, history } = makeCtx(8, 8, { opacity: 40 });
    tool.onDown(ev(1, 1), ctx);
    tool.onMove(ev(5, 1), ctx);
    tool.onUp(ev(5, 1), ctx);
    expect(history.length).toBe(1);
    const cmd = history.undo();
    expect(cmd?.kind).toBe('tiles');
    if (cmd?.kind === 'tiles') applyTiles(doc.activeLayer!.imageData, cmd.before);
    expect(px(doc, 2, 1)[3]).toBe(0);
  });
});

describe('mirrorX', () => {
  it('stamps the mirrored pixel in the SAME stroke/command', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc, history } = makeCtx(8, 8, { mirrorX: true });
    tool.onDown(ev(1, 2), ctx);
    tool.onUp(ev(1, 2), ctx);
    expect(px(doc, 1, 2)[3]).toBe(255);
    expect(px(doc, 6, 2)[3]).toBe(255); // width-1-1 = 6
    expect(history.length).toBe(1);
  });
});

describe('dither', () => {
  it('hard brush skips checkerboard-odd pixels', () => {
    const tool = createBrushTool('brush');
    const { ctx, doc } = makeCtx(8, 8, { dither: true, size: 4 });
    tool.onDown(ev(2, 2), ctx);
    tool.onUp(ev(2, 2), ctx);
    // (px+py) even → painted; odd → skipped
    expect(px(doc, 2, 2)[3]).toBe(255);
    expect(px(doc, 3, 2)[3]).toBe(0);
    expect(px(doc, 3, 3)[3]).toBe(255);
  });
});
