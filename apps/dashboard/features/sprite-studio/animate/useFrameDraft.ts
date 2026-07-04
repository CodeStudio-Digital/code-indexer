/**
 * Local frame-draft for the animation timeline: holds the working frame list +
 * playhead, commits edits to the server via PATCH frames debounced 500ms, and
 * exposes a flush the align route needs (it reads the SERVER list). Extracted
 * from AnimatePanel for the LOC ceiling.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as anim from './api-anim.js';

export function useFrameDraft(
  current: anim.SpriteAnimation | null,
  applyServer: (updated: anim.SpriteAnimation) => void,
  onError: (msg: string) => void,
): {
  frames: anim.AnimFrame[];
  frameIdx: number;
  setFrameIdx: React.Dispatch<React.SetStateAction<number>>;
  editFrames: (next: anim.AnimFrame[]) => void;
  resetForAnimation: (serverFrames: anim.AnimFrame[]) => void;
  flushPendingSave: () => Promise<void>;
} {
  const [frames, setFrames] = useState<anim.AnimFrame[]>([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const persist = (list: anim.AnimFrame[]) =>
    list.map((f, i) => ({ frameIndex: i, versionId: f.versionId, durationMs: f.durationMs }));

  // Timeline edits: local draft immediately, PATCH debounced 500ms.
  const editFrames = useCallback((next: anim.AnimFrame[]) => {
    setFrames(next);
    if (!current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void anim.saveFrames(current.id, persist(next)).then(applyServer)
        .catch((e) => onError((e as Error).message));
    }, 500);
  }, [current, applyServer, onError]);

  const resetForAnimation = useCallback((serverFrames: anim.AnimFrame[]) => {
    setFrames(serverFrames);
    setFrameIdx(0);
  }, []);

  // Flush a pending debounced save NOW (align reads the server frame list).
  const flushPendingSave = useCallback(async () => {
    if (!current || !saveTimer.current) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = null;
    await anim.saveFrames(current.id, persist(frames));
  }, [current, frames]);

  return { frames, frameIdx, setFrameIdx, editFrames, resetForAnimation, flushPendingSave };
}
