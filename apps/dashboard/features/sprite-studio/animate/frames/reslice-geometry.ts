/** Shared source-pixel geometry for re-slice preview and tests. Mirrors
 * packages/sprite-studio/src/processing/slice.ts::sliceGridAdvanced. */
export interface Nudge { dx: number; dy: number }

export interface ResliceGeometryInput {
  width: number;
  height: number;
  cols: number;
  rows: number;
  offsetX?: number;
  offsetY?: number;
  marginX?: number;
  marginY?: number;
}

export interface ResliceLayout {
  width: number;
  height: number;
  cols: number;
  rows: number;
  offsetX: number;
  offsetY: number;
  marginX: number;
  marginY: number;
  usableW: number;
  usableH: number;
  cellW: number;
  cellH: number;
  maxX: number;
  maxY: number;
}

export interface ResliceCellRect { x: number; y: number; w: number; h: number }

const floorNonNegative = (n: number | undefined): number => Math.max(0, Math.floor(n ?? 0));

export function computeResliceLayout(input: ResliceGeometryInput): ResliceLayout {
  const width = Math.max(1, Math.floor(input.width));
  const height = Math.max(1, Math.floor(input.height));
  const cols = Math.max(1, Math.floor(input.cols));
  const rows = Math.max(1, Math.floor(input.rows));
  const offsetX = floorNonNegative(input.offsetX);
  const offsetY = floorNonNegative(input.offsetY);
  const marginX = floorNonNegative(input.marginX);
  const marginY = floorNonNegative(input.marginY);
  const usableW = width - offsetX - marginX;
  const usableH = height - offsetY - marginY;
  const cellW = Math.max(1, Math.floor(usableW / cols));
  const cellH = Math.max(1, Math.floor(usableH / rows));
  return {
    width,
    height,
    cols,
    rows,
    offsetX,
    offsetY,
    marginX,
    marginY,
    usableW,
    usableH,
    cellW,
    cellH,
    maxX: Math.max(0, width - cellW),
    maxY: Math.max(0, height - cellH),
  };
}

export function resliceCellRect(layout: ResliceLayout, idx: number, nudge: Nudge = { dx: 0, dy: 0 }): ResliceCellRect {
  const col = idx % layout.cols;
  const row = Math.floor(idx / layout.cols);
  const x = Math.max(0, Math.min(layout.maxX, layout.offsetX + col * layout.cellW + Math.round(nudge.dx)));
  const y = Math.max(0, Math.min(layout.maxY, layout.offsetY + row * layout.cellH + Math.round(nudge.dy)));
  return { x, y, w: layout.cellW, h: layout.cellH };
}

export function clampResliceNudge(layout: ResliceLayout, idx: number, nudge: Nudge): Nudge {
  const col = idx % layout.cols;
  const row = Math.floor(idx / layout.cols);
  const baseX = layout.offsetX + col * layout.cellW;
  const baseY = layout.offsetY + row * layout.cellH;
  const minDx = baseX === 0 ? 0 : -baseX;
  const minDy = baseY === 0 ? 0 : -baseY;
  return {
    dx: Math.max(minDx, Math.min(layout.maxX - baseX, nudge.dx)),
    dy: Math.max(minDy, Math.min(layout.maxY - baseY, nudge.dy)),
  };
}
