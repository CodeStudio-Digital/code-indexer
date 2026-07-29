/**
 * Column/cell operations over the multi-track draft + the cross-rail bridge
 * publication. Column ops follow D6 (Aseprite semantics): they move/copy the
 * WHOLE column across every layer; cell ops touch one (track, col). The
 * column clipboard stores the full vertical stack. Extracted from
 * AnimatePanel for the LOC ceiling.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { AnimFrame } from './api-anim.js';
import { useAnimateSession } from './animate-session-store.js';
import {
  clearCell, duplicateColumn, moveColumn, removeColumn, reverseColumns, setCell,
  type TimelineModel,
} from './timeline-model.js';

export interface TimelineOps {
  setCellAt: (track: number, col: number, versionId: string) => void;
  clearCellAt: (track: number, col: number) => void;
  setDuration: (col: number, ms: number | null) => void;
  columnDrag: (from: number, to: number) => void;
  cellDrag: (track: number, from: number, to: number) => void;
  duplicateColumnAt: (col: number) => void;
  removeColumnAt: (col: number) => void;
  reverse: () => void;
  copyColumn: () => void;
  pasteColumn: () => void;
  moveColumnBy: (dir: -1 | 1) => void;
  appendVersion: (versionId: string) => void;
}

/** Replace/restore a batch as a clean base timeline. Overlay cells are dropped
 *  deliberately: their old columns were aligned to the previous base sequence. */
export function replaceWithBaseTimeline(versionIds: string[]): AnimFrame[] {
  return versionIds.map((versionId, i) => ({
    id: `draft:0:${i}:${versionId}`,
    frameIndex: i,
    versionId,
    durationMs: null,
    track: 0,
  }));
}

export function replaceFrameIfCurrent(
  frames: AnimFrame[],
  track: number,
  col: number,
  versionId: string,
  expectedVersionId?: string,
): AnimFrame[] {
  const current = frames.find((f) => f.track === track && f.frameIndex === col)?.versionId ?? null;
  if (expectedVersionId != null && current !== expectedVersionId) return frames;
  return setCell(frames, track, col, versionId);
}

export function useTimelineOps(args: {
  model: TimelineModel;
  frames: AnimFrame[];
  activeTrack: number;
  frameIdx: number;
  setFrameIdx: React.Dispatch<React.SetStateAction<number>>;
  applyFlat: (next: AnimFrame[]) => void;
  hasAnimation: boolean;
}): TimelineOps {
  const { model, frames, activeTrack, frameIdx, setFrameIdx, applyFlat, hasAnimation } = args;
  const publishBridge = useAnimateSession((s) => s.publishBridge);
  const clip = useRef<Array<{ track: number; versionId: string }> | null>(null);

  useEffect(() => {
    if (!hasAnimation) return;
    if (model.gridLen <= 0) {
      if (frameIdx !== 0) setFrameIdx(0);
      return;
    }
    const clamped = Math.max(0, Math.min(model.gridLen - 1, frameIdx));
    if (clamped !== frameIdx) setFrameIdx(clamped);
  }, [hasAnimation, model.gridLen, frameIdx, setFrameIdx]);

  const ops: TimelineOps = {
    setCellAt: useCallback((track, col, versionId) => {
      applyFlat(setCell(frames, track, col, versionId));
    }, [frames, applyFlat]),
    clearCellAt: useCallback((track, col) => {
      applyFlat(clearCell(frames, track, col));
    }, [frames, applyFlat]),
    setDuration: useCallback((col, ms) => {
      applyFlat(frames.map((f) => (f.track === 0 && f.frameIndex === col ? { ...f, durationMs: ms } : f)));
    }, [frames, applyFlat]),
    columnDrag: useCallback((from, to) => {
      applyFlat(moveColumn(frames, from, to));
      setFrameIdx(() => to);
    }, [frames, applyFlat, setFrameIdx]),
    cellDrag: useCallback((track, from, to) => {
      const cell = frames.find((f) => f.track === track && f.frameIndex === from);
      if (!cell) return;
      applyFlat(setCell(clearCell(frames, track, from), track, to, cell.versionId));
    }, [frames, applyFlat]),
    duplicateColumnAt: useCallback((col) => {
      applyFlat(duplicateColumn(frames, col));
      setFrameIdx(() => col + 1);
    }, [frames, applyFlat, setFrameIdx]),
    removeColumnAt: useCallback((col) => {
      applyFlat(removeColumn(frames, col));
      setFrameIdx((i) => Math.max(0, Math.min(model.gridLen - 2, i)));
    }, [frames, applyFlat, model.gridLen, setFrameIdx]),
    reverse: useCallback(() => {
      if (model.gridLen > 1) applyFlat(reverseColumns(frames, model.gridLen));
    }, [frames, model.gridLen, applyFlat]),
    copyColumn: useCallback(() => {
      const stack = frames.filter((f) => f.frameIndex === frameIdx);
      clip.current = stack.map((f) => ({ track: f.track, versionId: f.versionId }));
    }, [frames, frameIdx]),
    pasteColumn: useCallback(() => {
      if (!clip.current || clip.current.length === 0) return;
      let next = duplicateColumn(frames, frameIdx);
      // Overwrite the duplicated column with the clipboard's stack.
      next = next.filter((f) => f.frameIndex !== frameIdx + 1);
      for (const c of clip.current) next = setCell(next, c.track, frameIdx + 1, c.versionId);
      applyFlat(next);
      setFrameIdx(() => frameIdx + 1);
    }, [frames, frameIdx, applyFlat, setFrameIdx]),
    moveColumnBy: useCallback((dir) => {
      const to = frameIdx + dir;
      if (to < 0 || to >= model.gridLen) return;
      applyFlat(moveColumn(frames, frameIdx, to));
      setFrameIdx(() => to);
    }, [frames, frameIdx, model.gridLen, applyFlat, setFrameIdx]),
    appendVersion: useCallback((versionId) => {
      applyFlat(setCell(frames, activeTrack, model.gridLen, versionId));
      setFrameIdx(() => model.gridLen);
    }, [frames, activeTrack, model.gridLen, applyFlat, setFrameIdx]),
  };

  // Bridge: publish the grid + the imperative callbacks the other rails call.
  useEffect(() => {
    if (!hasAnimation) return;
    const selectedFrameIndex = frameIdx >= 0 && frameIdx < model.gridLen ? frameIdx : null;
    publishBridge({
      frameVersionIds: [...new Set(frames.map((f) => f.versionId))],
      selectedFrameVersionId: selectedFrameIndex == null ? null : model.cellAt(activeTrack, selectedFrameIndex)?.versionId ?? null,
      selectedFrameIndex,
      appendToTimeline: (ids) => {
        let next = frames;
        let col = model.gridLen;
        for (const versionId of ids) next = setCell(next, activeTrack, col++, versionId);
        applyFlat(next);
      },
      removeFramesUsing: (ids) => applyFlat(frames.filter((f) => !ids.includes(f.versionId))),
      replaceFrameAt: (col, versionId, track = activeTrack, expectedVersionId) => {
        if (col < 0 || col >= model.gridLen) return;
        const next = replaceFrameIfCurrent(frames, track, col, versionId, expectedVersionId);
        if (next !== frames) applyFlat(next);
      },
      setTimeline: (ids) => {
        const next = replaceWithBaseTimeline(ids);
        useAnimateSession.getState().onActivateTrack?.(0);
        applyFlat(next);
        setFrameIdx(() => 0);
        publishBridge({
          frameVersionIds: [...new Set(ids)],
          selectedFrameIndex: ids.length > 0 ? 0 : null,
          selectedFrameVersionId: ids[0] ?? null,
          activeTrack: 0,
        });
      },
    });
  }, [hasAnimation, frames, model, activeTrack, frameIdx, applyFlat, setFrameIdx, publishBridge]);
  useEffect(() => () => {
    publishBridge({
      frameVersionIds: [], selectedFrameVersionId: null, selectedFrameIndex: null,
      appendToTimeline: null, removeFramesUsing: null, replaceFrameAt: null, setTimeline: null,
      inspectorTracks: [], activeTrack: 0, animContext: null,
      onActivateTrack: null, onToggleTrackVisible: null,
    });
  }, [publishBridge]);

  return ops;
}
