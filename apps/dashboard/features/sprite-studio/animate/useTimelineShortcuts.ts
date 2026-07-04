/**
 * Timeline keyboard bindings (Aseprite-style) over the COLUMN ops supplied by
 * useTimelineOps — the hook owns no timeline logic itself:
 *   Del/Backspace remove column · Ctrl/Cmd+C/V copy/paste column ·
 *   Ctrl/Cmd+D duplicate · [ / ] move column · ←/→ move the playhead.
 * Skips text inputs; installed on window while the animate surface is up.
 */
import { useEffect } from 'react';
import type { TimelineOps } from './useTimelineOps.js';

export function useTimelineShortcuts(
  ops: Pick<TimelineOps, 'removeColumnAt' | 'duplicateColumnAt' | 'copyColumn' | 'pasteColumn' | 'moveColumnBy'>,
  frameIdx: number,
  gridLen: number,
  setFrameIdx: (updater: (i: number) => number) => void,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'c') { ops.copyColumn(); e.preventDefault(); }
      else if (mod && k === 'v') { ops.pasteColumn(); e.preventDefault(); }
      else if (mod && k === 'd') { ops.duplicateColumnAt(frameIdx); e.preventDefault(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { ops.removeColumnAt(frameIdx); e.preventDefault(); }
      else if (e.key === '[') { ops.moveColumnBy(-1); e.preventDefault(); }
      else if (e.key === ']') { ops.moveColumnBy(1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { setFrameIdx((i) => Math.max(0, i - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { setFrameIdx((i) => Math.min(gridLen - 1, i + 1)); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, ops, frameIdx, gridLen, setFrameIdx]);
}
