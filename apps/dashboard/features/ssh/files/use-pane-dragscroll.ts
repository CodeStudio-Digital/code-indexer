/**
 * Auto-scroll a pane while dragging near its top/bottom edge.
 *
 * WHY this is required, not a nicety: the panes are virtualized, so a row below
 * the fold does not exist in the DOM. Before virtualization you could drag onto
 * any visible row and the rest were at least reachable by scrolling first (the
 * wheel still works mid-drag). With virtualization, a folder you scrolled past
 * has no drop target at all until it is rendered — so without an edge-scroll
 * the user simply cannot drop into anything outside the current window.
 *
 * Uses requestAnimationFrame rather than a timer so the scroll is smooth and
 * stops cleanly with the drag; speed ramps with how deep into the hot zone the
 * cursor is, which makes short corrections controllable and long runs fast.
 */
import { useCallback, useEffect, useRef, type DragEvent } from 'react';

/** Distance from an edge, in px, where auto-scroll kicks in. */
const HOT_ZONE = 28;
/** Max px per frame at the very edge (~60fps → ~840 px/s). */
const MAX_SPEED = 14;

export function usePaneDragScroll(el: HTMLElement | null) {
  const speed = useRef(0);
  const frame = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    speed.current = 0;
  }, []);

  // Never leave a rAF loop running behind an unmounted pane.
  useEffect(() => stop, [stop]);

  const pump = useCallback(() => {
    if (!el || speed.current === 0) {
      frame.current = null;
      return;
    }
    el.scrollTop += speed.current;
    frame.current = requestAnimationFrame(pump);
  }, [el]);

  /** Call from the scroll container's `onDragOver`. */
  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const fromTop = e.clientY - rect.top;
      const fromBottom = rect.bottom - e.clientY;

      let next = 0;
      if (fromTop < HOT_ZONE) next = -ramp(HOT_ZONE - fromTop);
      else if (fromBottom < HOT_ZONE) next = ramp(HOT_ZONE - fromBottom);

      speed.current = next;
      if (next !== 0 && frame.current == null) frame.current = requestAnimationFrame(pump);
      else if (next === 0) stop();
    },
    [el, pump, stop],
  );

  return { onDragOver, stopDragScroll: stop };
}

/** 0 at the zone's outer edge → MAX_SPEED at the container edge. */
function ramp(depth: number): number {
  const t = Math.min(1, Math.max(0, depth / HOT_ZONE));
  return Math.max(1, Math.round(t * MAX_SPEED));
}
