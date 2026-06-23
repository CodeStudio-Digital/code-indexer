/**
 * Drag-to-resize a panel's width.
 *
 * Designed for a right-anchored drawer: dragging the handle LEFT
 * makes the drawer wider (`anchor: 'right'`), dragging RIGHT shrinks
 * it. Width is clamped to `[minWidth, maxWidth]` and optionally
 * persisted to localStorage so the user's preferred size survives
 * reloads.
 *
 * Pattern:
 *   const { width, startResize, resizing } = useResizableWidth({...});
 *   <div style={{ width }}>
 *     <div onMouseDown={startResize} className="cursor-col-resize w-1" />
 *     ...content...
 *   </div>
 *
 * Global mousemove/mouseup listeners are attached only while a drag
 * is in flight, and the body cursor is forced to `col-resize` so the
 * user keeps the visual cue even when crossing widgets that would
 * otherwise change it (iframes, code editors, etc.).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseResizableWidthOptions {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** When provided, current width is read/written via localStorage. */
  storageKey?: string;
  /**
   * Which edge the panel is anchored to. `'right'` (default) means
   * the panel sits on the right side of the screen and the handle
   * is on its LEFT edge — drag-left grows it. `'left'` reverses
   * the direction.
   */
  anchor?: 'left' | 'right';
}

export interface UseResizableWidthResult {
  width: number;
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

export function useResizableWidth(opts: UseResizableWidthOptions): UseResizableWidthResult {
  const { defaultWidth, minWidth, maxWidth, storageKey, anchor = 'right' } = opts;

  const [width, setWidth] = useState<number>(() => {
    if (storageKey) {
      const stored = readStored(storageKey, minWidth, maxWidth);
      if (stored != null) return stored;
    }
    return clamp(defaultWidth, minWidth, maxWidth);
  });
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // `widthRef` mirrors `width` so the mouseup handler can persist the
  // latest value without re-binding listeners on every render.
  const widthRef = useRef(width);
  widthRef.current = width;

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: widthRef.current };
      setResizing(true);
    },
    [],
  );

  useEffect(() => {
    if (!resizing) return;

    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = anchor === 'right' ? d.startX - e.clientX : e.clientX - d.startX;
      setWidth(clamp(d.startWidth + dx, minWidth, maxWidth));
    }
    function onUp() {
      dragRef.current = null;
      setResizing(false);
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, String(widthRef.current));
        } catch {
          /* quota / private mode — best-effort persistence */
        }
      }
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [resizing, anchor, minWidth, maxWidth, storageKey]);

  return { width, resizing, startResize };
}
