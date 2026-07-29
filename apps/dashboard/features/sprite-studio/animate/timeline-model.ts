/**
 * Shared timeline model for multi-track animations (pure — no React). One
 * flat AnimFrame[] (with track) + TrackMeta[] fold into an addressable grid:
 * gridLen counts EVERY track's indices (hidden tracks still hold columns),
 * durations follow the shared-time-grid rule (track 0 is the master line),
 * and visibleStack(col) yields the bottom-up compositing order for the
 * preview. TimelineStrip, PreviewCanvas and the cross-rail bridge all read
 * through this so they can never disagree about the grid.
 */
import type { AnimFrame, TrackMeta } from './api-anim.js';

export interface TimelineModel {
  gridLen: number;
  tracks: TrackMeta[];
  cellAt(track: number, col: number): AnimFrame | null;
  /** Column duration in ms (track 0's duration_ms ?? 1000/fps). */
  columnDuration(col: number): number;
  /** Visible cells of a column, bottom-up (ascending track id). */
  visibleStack(col: number): AnimFrame[];
  /** One track's cells as a sparse array indexed by column. */
  trackCells(track: number): Array<AnimFrame | null>;
}

export function buildTimelineModel(
  frames: AnimFrame[],
  tracks: TrackMeta[],
  fps: number,
): TimelineModel {
  const byKey = new Map<string, AnimFrame>();
  let maxIndex = -1;
  for (const f of frames) {
    byKey.set(`${f.track}:${f.frameIndex}`, f);
    if (f.frameIndex > maxIndex) maxIndex = f.frameIndex;
  }
  const gridLen = maxIndex + 1;
  const defaultMs = Math.round(1000 / Math.max(1, fps));
  const visibleIds = tracks.filter((t) => t.visible).map((t) => t.id).sort((a, b) => a - b);

  return {
    gridLen,
    tracks,
    cellAt: (track, col) => byKey.get(`${track}:${col}`) ?? null,
    columnDuration: (col) => byKey.get(`0:${col}`)?.durationMs ?? defaultMs,
    visibleStack: (col) =>
      visibleIds
        .map((id) => byKey.get(`${id}:${col}`))
        .filter((f): f is AnimFrame => f != null),
    trackCells: (track) => {
      const out: Array<AnimFrame | null> = [];
      for (let col = 0; col < gridLen; col++) out.push(byKey.get(`${track}:${col}`) ?? null);
      return out;
    },
  };
}

// ── Column operations (Aseprite semantics: track-0 gestures move the WHOLE
//    column across every layer) — pure, return a new flat list. ──────────────

const remap = (frames: AnimFrame[], f: (col: number) => number | null): AnimFrame[] => {
  const out: AnimFrame[] = [];
  for (const fr of frames) {
    const col = f(fr.frameIndex);
    if (col == null) continue; // dropped column
    out.push(col === fr.frameIndex ? fr : { ...fr, frameIndex: col });
  }
  return out;
};

const draftFrameId = (track: number, col: number, versionId: string): string =>
  `draft:${track}:${col}:${versionId}`;

/** Delete a column in every track (right side shifts left). */
export function removeColumn(frames: AnimFrame[], col: number): AnimFrame[] {
  return remap(frames, (c) => (c === col ? null : c > col ? c - 1 : c));
}

/** Duplicate a column (copies every track's cell; right side shifts right). */
export function duplicateColumn(frames: AnimFrame[], col: number): AnimFrame[] {
  const shifted = remap(frames, (c) => (c > col ? c + 1 : c));
  const copies = frames
    .filter((f) => f.frameIndex === col)
    .map((f) => ({
      ...f,
      id: draftFrameId(f.track, col + 1, f.versionId),
      frameIndex: col + 1,
    }));
  return [...shifted, ...copies];
}

/** Move a column to another position (every track follows). */
export function moveColumn(frames: AnimFrame[], from: number, to: number): AnimFrame[] {
  if (from === to) return frames;
  return remap(frames, (c) => {
    if (c === from) return to;
    if (from < to) return c > from && c <= to ? c - 1 : c;
    return c >= to && c < from ? c + 1 : c;
  });
}

/** Reverse the column order of the whole grid. */
export function reverseColumns(frames: AnimFrame[], gridLen: number): AnimFrame[] {
  return remap(frames, (c) => gridLen - 1 - c);
}

/** Set/replace ONE cell (track, col) to a version (draft id = unsaved row). */
export function setCell(
  frames: AnimFrame[],
  track: number,
  col: number,
  versionId: string,
): AnimFrame[] {
  const rest = frames.filter((f) => !(f.track === track && f.frameIndex === col));
  return [
    ...rest,
    {
      id: draftFrameId(track, col, versionId),
      frameIndex: col,
      versionId,
      durationMs: null,
      track,
    },
  ];
}

/** Clear ONE cell (empty cells are simply absent rows). */
export function clearCell(frames: AnimFrame[], track: number, col: number): AnimFrame[] {
  return frames.filter((f) => !(f.track === track && f.frameIndex === col));
}

/** The distinct track ids that have at least one cell. */
export function tracksWithCells(frames: AnimFrame[]): number[] {
  return [...new Set(frames.map((f) => f.track))].sort((a, b) => a - b);
}
