/**
 * Local frame-draft for the multi-track timeline: holds the FLAT frame list
 * (every track) + playhead, and commits edits per track — one debounced PATCH
 * timer per track id (editing two layers within 500ms loses neither). Track 0
 * persists as a dense reorder (indices rewritten server-side); overlay tracks
 * persist sparse explicit indices. `applyFlat` diffs which tracks changed and
 * schedules exactly those. `flushPendingSave` drains every pending timer (the
 * align route reads the SERVER list).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as anim from './api-anim.js';
import { tracksWithCells } from './timeline-model.js';

const DEBOUNCE_MS = 500;

export function useFrameDraft(
  current: anim.SpriteAnimation | null,
  applyServer: (updated: anim.SpriteAnimation) => void,
  onError: (msg: string) => void,
): {
  frames: anim.AnimFrame[];
  frameIdx: number;
  setFrameIdx: React.Dispatch<React.SetStateAction<number>>;
  /** Replace the whole flat draft; PATCHes are scheduled per CHANGED track. */
  applyFlat: (next: anim.AnimFrame[]) => void;
  /** Replace one track's cells only (others untouched). */
  editTrackCells: (track: number, cells: anim.AnimFrame[]) => void;
  resetForAnimation: (serverFrames: anim.AnimFrame[]) => void;
  flushPendingSave: () => Promise<void>;
} {
  const [frames, setFrames] = useState<anim.AnimFrame[]>([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const latest = useRef<anim.AnimFrame[]>([]);
  latest.current = frames;

  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
  }, []);

  const persistTrack = useCallback(async (track: number) => {
    if (!current) return;
    const cells = latest.current
      .filter((f) => f.track === track)
      .sort((a, b) => a.frameIndex - b.frameIndex)
      .map((f) => ({ frameIndex: f.frameIndex, versionId: f.versionId, durationMs: f.durationMs }));
    try {
      applyServer(await anim.saveFrames(current.id, cells, track));
    } catch (e) {
      onError((e as Error).message);
    }
  }, [current, applyServer, onError]);

  const schedule = useCallback((tracks: number[]) => {
    if (!current) return;
    for (const track of tracks) {
      const prev = timers.current.get(track);
      if (prev) clearTimeout(prev);
      timers.current.set(track, setTimeout(() => {
        timers.current.delete(track);
        void persistTrack(track);
      }, DEBOUNCE_MS));
    }
  }, [current, persistTrack]);

  const applyFlat = useCallback((next: anim.AnimFrame[]) => {
    const prev = latest.current;
    setFrames(next);
    latest.current = next;
    // A track changed when its cell multiset differs (cheap string diff).
    const sig = (list: anim.AnimFrame[], track: number): string =>
      list
        .filter((f) => f.track === track)
        .sort((a, b) => a.frameIndex - b.frameIndex)
        .map((f) => `${f.frameIndex}:${f.versionId}:${f.durationMs ?? ''}`)
        .join('|');
    const all = new Set([...tracksWithCells(prev), ...tracksWithCells(next)]);
    const changed = [...all].filter((t) => sig(prev, t) !== sig(next, t));
    if (changed.length > 0) schedule(changed);
  }, [schedule]);

  const editTrackCells = useCallback((track: number, cells: anim.AnimFrame[]) => {
    const rest = latest.current.filter((f) => f.track !== track);
    applyFlat([...rest, ...cells.map((c) => ({ ...c, track }))]);
  }, [applyFlat]);

  const resetForAnimation = useCallback((serverFrames: anim.AnimFrame[]) => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    setFrames(serverFrames);
    latest.current = serverFrames;
    setFrameIdx(0);
  }, []);

  // Flush every pending debounced save NOW (align reads the server list).
  const flushPendingSave = useCallback(async () => {
    const pending = [...timers.current.keys()];
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    for (const track of pending) await persistTrack(track);
  }, [persistTrack]);

  return { frames, frameIdx, setFrameIdx, applyFlat, editTrackCells, resetForAnimation, flushPendingSave };
}
