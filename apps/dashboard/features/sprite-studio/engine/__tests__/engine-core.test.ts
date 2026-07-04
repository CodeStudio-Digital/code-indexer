/**
 * Pure engine-core tests: tile diff roundtrip, history budget/coalescing,
 * viewport zoom snapping and the overlay-registry enable toggle. PixelBuffer
 * is structural — no DOM ImageData.
 */
import { describe, expect, it } from 'vitest';
import type { PixelBuffer } from '../engine-types.js';
import { applyTiles, captureTiles, diffTiles, tilesForRect, TILE } from '../tile-diff.js';
import { History } from '../history.js';
import { OverlayRegistry, type Overlay, type OverlayView } from '../overlays.js';
import { Viewport, ZOOM_LADDER } from '../viewport.js';

function makeBuffer(w: number, h: number): PixelBuffer {
  const buf: PixelBuffer = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 0; i < buf.data.length; i++) buf.data[i] = (i * 7) % 256; // deterministic noise
  return buf;
}

describe('tile-diff', () => {
  it('captures edge-clipped tiles and roundtrips through apply', () => {
    const img = makeBuffer(130, 70); // 3×2 tile grid, right/bottom clipped
    const keys = tilesForRect({ x: 0, y: 0, w: 130, h: 70 }, 130, 70);
    expect(keys).toHaveLength(6);
    const before = captureTiles(img, keys);
    expect(before.bytes).toBe(130 * 70 * 4); // full coverage, no overlap

    // Mutate two pixels in different tiles.
    img.data[(5 * 130 + 5) * 4] = 250;
    img.data[(69 * 130 + 129) * 4 + 3] = 9;
    const after = captureTiles(img, keys);
    const diff = diffTiles(before.tiles, after.tiles);
    expect(diff.after).toHaveLength(2); // only the touched tiles survive

    applyTiles(img, diff.before);
    const pristine = makeBuffer(130, 70);
    expect([...img.data]).toEqual([...pristine.data]);
    applyTiles(img, diff.after);
    expect(img.data[(5 * 130 + 5) * 4]).toBe(250);
  });

  it('tilesForRect clips to bounds', () => {
    expect(tilesForRect({ x: -50, y: -50, w: 20, h: 20 }, 128, 128)).toHaveLength(0);
    expect(tilesForRect({ x: 60, y: 60, w: 10, h: 10 }, 128, 128)).toHaveLength(4); // straddles 4 tiles
  });
});

describe('history', () => {
  const sel = (bytes: number) => new Uint8Array(bytes);

  it('evicts oldest commands over the count budget', () => {
    const h = new History({ maxCommands: 3 });
    for (let i = 0; i < 5; i++) h.pushSelection(sel(8), sel(8), `s${i}`);
    expect(h.length).toBe(3);
    expect(h.canUndo).toBe(true);
  });

  it('evicts oldest commands over the byte budget, keeping the newest', () => {
    const h = new History({ byteBudget: 1000, maxCommands: 100 });
    h.pushSelection(sel(300), sel(0), 'a'); // 300 B
    h.pushSelection(sel(300), sel(0), 'b'); // 600 B
    h.pushSelection(sel(300), sel(0), 'c'); // 900 B
    h.pushSelection(sel(300), sel(0), 'd'); // 1200 B → evict "a"
    expect(h.length).toBe(3);
    // A single command bigger than the whole budget still lands (newest wins).
    h.pushSelection(sel(5000), sel(0), 'huge');
    expect(h.canUndo).toBe(true);
    expect(h.length).toBe(1);
  });

  it('push clears redo; undo/redo shuttle commands', () => {
    const h = new History();
    h.pushSelection(sel(1), sel(1), 'one');
    expect(h.undo()?.label).toBe('one');
    expect(h.canRedo).toBe(true);
    expect(h.redo()?.label).toBe('one');
    h.undo();
    h.pushSelection(sel(1), sel(1), 'two');
    expect(h.canRedo).toBe(false);
  });

  it('coalesces a whole stroke into one tile command (and drops no-ops)', () => {
    const img = makeBuffer(TILE * 2, TILE);
    const h = new History();
    h.beginStroke('layer-1', 'Brush');
    h.touchTiles(img, ['0:0', '1:0']);
    h.touchTiles(img, ['0:0']); // repeat touch is a no-op
    img.data[0] = 251; // change only within tile 0:0
    const cmd = h.endStroke(img);
    expect(cmd?.kind).toBe('tiles');
    expect(cmd && cmd.kind === 'tiles' ? cmd.after : []).toHaveLength(1);
    expect(h.length).toBe(1);

    h.beginStroke('layer-1', 'Brush');
    h.touchTiles(img, ['1:0']);
    expect(h.endStroke(img)).toBeNull(); // nothing changed → no command
    expect(h.length).toBe(1);
  });
});

describe('overlay registry enable toggle', () => {
  it('skips disabled overlays in both passes and restores them on re-enable', () => {
    const reg = new OverlayRegistry();
    const calls: string[] = [];
    const mk = (id: string, order: number): Overlay => ({ id, order, draw: () => { calls.push(id); } });
    reg.register(mk('checker', -100));
    reg.register(mk('grid', 10));
    const ctx = {} as CanvasRenderingContext2D;
    const view = {} as OverlayView;

    const drawAll = () => { reg.drawBelow(ctx, view); reg.drawAbove(ctx, view); };
    drawAll();
    expect(calls).toEqual(['checker', 'grid']);
    expect(reg.isEnabled('grid')).toBe(true);

    calls.length = 0;
    reg.setEnabled('grid', false);
    expect(reg.isEnabled('grid')).toBe(false);
    drawAll();
    expect(calls).toEqual(['checker']); // grid skipped, still registered

    calls.length = 0;
    reg.setEnabled('grid', true);
    drawAll();
    expect(calls).toEqual(['checker', 'grid']);
  });

  it('disabling also silences below-zero overlays', () => {
    const reg = new OverlayRegistry();
    const calls: string[] = [];
    reg.register({ id: 'under', order: -1, draw: () => { calls.push('under'); } });
    reg.setEnabled('under', false);
    reg.drawBelow({} as CanvasRenderingContext2D, {} as OverlayView);
    expect(calls).toEqual([]);
  });
});

describe('viewport zoom snap', () => {
  it('wheel-in walks the integer ladder when pixelPerfect', () => {
    const v = new Viewport();
    const seen: number[] = [];
    for (let i = 0; i < ZOOM_LADDER.length; i++) {
      v.wheelZoom(1.1, 0, 0);
      seen.push(v.zoom);
    }
    expect(seen).toEqual([2, 3, 4, 8, 16, 32, 32]); // clamped at max
    v.wheelZoom(0.9, 0, 0);
    expect(v.zoom).toBe(16);
  });

  it('below 1× zoom is free; wheel-in snaps back onto 1', () => {
    const v = new Viewport();
    v.wheelZoom(0.9, 0, 0); // from 1 → fractional
    expect(v.zoom).toBeLessThan(1);
    v.zoom = 0.95;
    v.wheelZoom(1.1, 0, 0); // crosses 1 → lands exactly on 1
    expect(v.zoom).toBe(1);
  });

  it('keeps the image point under the cursor fixed while zooming', () => {
    const v = new Viewport();
    const before = v.screenToImage(100, 50);
    v.wheelZoom(1.1, 100, 50);
    const after = v.screenToImage(100, 50);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(v.zoom).toBe(2);
  });

  it('fit snaps DOWN to the ladder and centers', () => {
    const v = new Viewport();
    v.fit(200, 200, 32, 32); // raw fit = 6.25 → ladder 4
    expect(v.zoom).toBe(4);
    expect(v.panX).toBe((200 - 32 * 4) / 2);
    expect(v.panY).toBe(v.panX);
  });

  it('non-pixelPerfect zoom is continuous', () => {
    const v = new Viewport();
    v.pixelPerfect = false;
    v.wheelZoom(1.1, 0, 0);
    expect(v.zoom).toBeCloseTo(1.1, 9);
  });
});
