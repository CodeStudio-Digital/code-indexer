/**
 * Tiny external store for the canvas cursor readout (image x/y + hovered
 * color). Kept OUT of the zustand editor-store on purpose: the hover fires at
 * pointer-move rate and must never churn the tool/undo store that the rail and
 * toolbar subscribe to. EditorCanvas publishes here (throttled); CanvasStatusBar
 * reads via useSyncExternalStore — only the status bar re-renders.
 */
import { useSyncExternalStore } from 'react';

export interface CursorReadout {
  /** Image-space integer coords, or null when the pointer is off the canvas. */
  x: number | null;
  y: number | null;
  /** `#rrggbb` under the cursor, or null. */
  hex: string | null;
}

const EMPTY: CursorReadout = { x: null, y: null, hex: null };

let current: CursorReadout = EMPTY;
const listeners = new Set<() => void>();

export function setCursorReadout(next: CursorReadout): void {
  if (next.x === current.x && next.y === current.y && next.hex === current.hex) return;
  current = next;
  for (const l of listeners) l();
}

export function clearCursorReadout(): void {
  setCursorReadout(EMPTY);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): CursorReadout {
  return current;
}

export function useCursorReadout(): CursorReadout {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
