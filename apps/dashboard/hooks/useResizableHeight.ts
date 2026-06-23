/**
 * Drag-to-resize a panel's height. Mirror of `useResizableHeight` for
 * the vertical axis — handle sits on the TOP edge of a bottom-anchored
 * panel; dragging UP grows it, dragging DOWN shrinks it.
 *
 * Usage:
 *   const { height, startResize, resizing } = useResizableHeight({...});
 *   <div onMouseDown={startResize} className="h-1 cursor-row-resize" />
 *   <div style={{ height }}>...content...</div>
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseResizableHeightOptions {
  defaultHeight: number;
  minHeight: number;
  maxHeight: number;
  /** When provided, current height is read/written via localStorage. */
  storageKey?: string;
  /**
   * Which edge the panel is anchored to. `'bottom'` (default) means the
   * panel sits at the bottom of the viewport and the handle is on its
   * TOP edge — drag-up grows it. `'top'` reverses the direction.
   */
  anchor?: 'top' | 'bottom';
}

export interface UseResizableHeightResult {
  height: number;
  resizing: boolean;
  startResize: (e: React.MouseEvent) => void;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readStored(key: string, lo: number, hi: number): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return clamp(n, lo, hi);
  } catch {
    return null;
  }
}

export function useResizableHeight(opts: UseResizableHeightOptions): UseResizableHeightResult {
  const { defaultHeight, minHeight, maxHeight, storageKey, anchor = 'bottom' } = opts;

  const [height, setHeight] = useState<number>(() => {
    if (storageKey) {
      const stored = readStored(storageKey, minHeight, maxHeight);
      if (stored != null) return stored;
    }
    return clamp(defaultHeight, minHeight, maxHeight);
  });
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: heightRef.current };
    setResizing(true);
  }, []);

  useEffect(() => {
    if (!resizing) return;

    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      // Anchor 'bottom': handle on the top, drag UP (negative dy)
      // grows the panel. Invert the delta to keep "drag-up = bigger".
      const dy = anchor === 'bottom' ? d.startY - e.clientY : e.clientY - d.startY;
      setHeight(clamp(d.startHeight + dy, minHeight, maxHeight));
    }
    function onUp() {
      dragRef.current = null;
      setResizing(false);
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, String(heightRef.current));
        } catch {
          /* quota / private mode — best-effort persistence */
        }
      }
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing, anchor, minHeight, maxHeight, storageKey]);

  return { height, resizing, startResize };
}
