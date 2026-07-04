/**
 * Timeline frame ops + keyboard shortcuts (Aseprite-style). Owns a small
 * frame clipboard and installs a scoped keydown handler while the animate
 * surface is mounted:
 *   Del/Backspace remove · Ctrl/Cmd+C/V copy/paste · Ctrl/Cmd+D duplicate ·
 *   [ / ] move frame left/right · ←/→ move the playhead.
 * All edits go through the existing editFrames(next) → debounced PATCH path.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { AnimFrame } from './api-anim.js';

const reindex = (list: AnimFrame[]): AnimFrame[] => list.map((f, i) => ({ ...f, frameIndex: i }));

export function useTimelineShortcuts(
  frames: AnimFrame[],
  frameIdx: number,
  editFrames: (next: AnimFrame[]) => void,
  setFrameIdx: (updater: (i: number) => number) => void,
  enabled: boolean,
): { reverse: () => void; copyFrame: () => void; pasteFrame: () => void } {
  const clip = useRef<AnimFrame | null>(null);

  const remove = useCallback(() => {
    if (frames.length === 0) return;
    editFrames(reindex(frames.filter((_, k) => k !== frameIdx)));
    setFrameIdx((i) => Math.max(0, Math.min(frames.length - 2, i)));
  }, [frames, frameIdx, editFrames, setFrameIdx]);

  const duplicate = useCallback(() => {
    if (frames.length === 0) return;
    const next = [...frames];
    next.splice(frameIdx + 1, 0, { ...frames[frameIdx] });
    editFrames(reindex(next));
    setFrameIdx(() => frameIdx + 1);
  }, [frames, frameIdx, editFrames, setFrameIdx]);

  const copyFrame = useCallback(() => {
    clip.current = frames[frameIdx] ? { ...frames[frameIdx] } : null;
  }, [frames, frameIdx]);

  const pasteFrame = useCallback(() => {
    if (!clip.current) return;
    const next = [...frames];
    next.splice(frameIdx + 1, 0, { ...clip.current, id: -1 });
    editFrames(reindex(next));
    setFrameIdx(() => frameIdx + 1);
  }, [frames, frameIdx, editFrames, setFrameIdx]);

  const reverse = useCallback(() => {
    if (frames.length < 2) return;
    editFrames(reindex([...frames].reverse()));
  }, [frames, editFrames]);

  const move = useCallback((dir: number) => {
    const to = frameIdx + dir;
    if (to < 0 || to >= frames.length) return;
    const next = [...frames];
    const [m] = next.splice(frameIdx, 1);
    next.splice(to, 0, m);
    editFrames(reindex(next));
    setFrameIdx(() => to);
  }, [frames, frameIdx, editFrames, setFrameIdx]);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'c') { copyFrame(); e.preventDefault(); }
      else if (mod && k === 'v') { pasteFrame(); e.preventDefault(); }
      else if (mod && k === 'd') { duplicate(); e.preventDefault(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { remove(); e.preventDefault(); }
      else if (e.key === '[') { move(-1); e.preventDefault(); }
      else if (e.key === ']') { move(1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { setFrameIdx((i) => Math.max(0, i - 1)); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { setFrameIdx((i) => Math.min(frames.length - 1, i + 1)); e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, frames.length, copyFrame, pasteFrame, duplicate, remove, move, setFrameIdx]);

  return { reverse, copyFrame, pasteFrame };
}
