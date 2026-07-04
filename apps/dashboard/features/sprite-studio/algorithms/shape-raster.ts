/**
 * Pure shape rasterizers for the line/rect/ellipse tools — pixel-exact point
 * generators the tools stamp on commit AND the overlay re-runs for the live
 * preview (what you see is exactly what lands). Node-testable, no DOM.
 */

export interface Pt { x: number; y: number }

/** Bresenham line, inclusive endpoints. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const out: Pt[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return out;
}

/** Rectangle outline (normalized corners, inclusive), deduped for 1px sides. */
export function rectOutlinePoints(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
  const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
  const out: Pt[] = [];
  for (let x = lo.x; x <= hi.x; x++) {
    out.push({ x, y: lo.y });
    if (hi.y !== lo.y) out.push({ x, y: hi.y });
  }
  for (let y = lo.y + 1; y <= hi.y - 1; y++) {
    out.push({ x: lo.x, y });
    if (hi.x !== lo.x) out.push({ x: hi.x, y });
  }
  return out;
}

/** Horizontal fill spans (y, xStart..xEnd inclusive) of a rectangle. */
export function rectFillSpans(x0: number, y0: number, x1: number, y1: number): Array<{ y: number; x0: number; x1: number }> {
  const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
  const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
  const out: Array<{ y: number; x0: number; x1: number }> = [];
  for (let y = lo.y; y <= hi.y; y++) out.push({ y, x0: lo.x, x1: hi.x });
  return out;
}

/** Midpoint ellipse outline inscribed in the (inclusive) bounding box — 4-way
 *  symmetric around the box center (handles even/odd extents via 2x math). */
export function ellipseOutlinePoints(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
  const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
  const w = hi.x - lo.x + 1;
  const h = hi.y - lo.y + 1;
  if (w <= 2 || h <= 2) return rectOutlinePoints(x0, y0, x1, y1);
  // Work in doubled coordinates so half-pixel centers stay integral.
  const a = w - 1; // horizontal diameter in steps
  const b = h - 1;
  const seen = new Set<number>();
  const out: Pt[] = [];
  const push = (x: number, y: number): void => {
    const k = y * 100_000 + x;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ x, y });
  };
  // Parametric sweep dense enough for ≤32-ish px shapes; dedupe keeps it exact.
  const steps = Math.max(32, (w + h) * 2);
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * Math.PI * 2;
    const x = Math.round(lo.x + (a / 2) * (1 + Math.cos(th)));
    const y = Math.round(lo.y + (b / 2) * (1 + Math.sin(th)));
    push(x, y);
  }
  return out;
}

/** Horizontal fill spans of the ellipse inscribed in the bounding box. */
export function ellipseFillSpans(x0: number, y0: number, x1: number, y1: number): Array<{ y: number; x0: number; x1: number }> {
  const lo = { x: Math.min(x0, x1), y: Math.min(y0, y1) };
  const hi = { x: Math.max(x0, x1), y: Math.max(y0, y1) };
  const w = hi.x - lo.x + 1;
  const h = hi.y - lo.y + 1;
  const cx = lo.x + (w - 1) / 2;
  const cy = lo.y + (h - 1) / 2;
  const rx = Math.max(0.5, w / 2);
  const ry = Math.max(0.5, h / 2);
  const out: Array<{ y: number; x0: number; x1: number }> = [];
  for (let y = lo.y; y <= hi.y; y++) {
    const ny = (y - cy) / ry;
    const k = 1 - ny * ny;
    if (k < 0) continue;
    const half = rx * Math.sqrt(k);
    const xs = Math.max(lo.x, Math.round(cx - half + 0.25));
    const xe = Math.min(hi.x, Math.round(cx + half - 0.25));
    if (xe >= xs) out.push({ y, x0: xs, x1: xe });
  }
  return out;
}

/** Shift-constrain: 45° snapping for lines, square/circle for boxes. */
export function constrain(
  kind: 'line' | 'rect' | 'ellipse',
  x0: number, y0: number, x1: number, y1: number,
): Pt {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (kind === 'line') {
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx > ady * 2) return { x: x1, y: y0 };           // horizontal
    if (ady > adx * 2) return { x: x0, y: y1 };           // vertical
    const d = Math.max(adx, ady);                          // 45°
    return { x: x0 + Math.sign(dx || 1) * d, y: y0 + Math.sign(dy || 1) * d };
  }
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: x0 + Math.sign(dx || 1) * d, y: y0 + Math.sign(dy || 1) * d };
}
