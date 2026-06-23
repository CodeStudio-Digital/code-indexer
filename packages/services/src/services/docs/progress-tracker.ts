/**
 * In-memory cache of the most recent `DocIngestProgress` frame emitted by
 * `IndexDocumentationUseCase` per source. Lets the UI poll
 * `GET /api/docs/sources/:id/progress` and see a live snapshot instead
 * of having to (re-)attach to the SSE stream — the dashboard's list view
 * doesn't keep streams open, and re-attach across runs is not supported.
 *
 * The tracker is intentionally non-persistent: a server restart loses
 * everything, which is fine because the `recoverStaleSources` boot path
 * already flips any in-flight source to `error`, and the user can
 * recover via the per-source retry endpoint.
 *
 * Lifecycle:
 *   - `put(sourceId, frame)` on every `onProgress` call inside the
 *     use-case.
 *   - `get(sourceId)` from the HTTP route; returns the latest snapshot
 *     (or null when nothing has been emitted yet).
 *   - `clear(sourceId)` is called at the START of a new run so the old
 *     frame doesn't leak into the new one. Terminal frames (done/error)
 *     are kept around so a slow poll right after completion can still
 *     read the final result.
 */
import type { DocIngestProgress } from './types.js';

export interface ProgressSnapshot extends DocIngestProgress {
  source_id: number;
  /** Wall-clock ms epoch when the frame was recorded. */
  updated_at: number;
}

export class DocIngestProgressTracker {
  private snapshots = new Map<number, ProgressSnapshot>();

  put(sourceId: number, frame: DocIngestProgress): void {
    this.snapshots.set(sourceId, { ...frame, source_id: sourceId, updated_at: Date.now() });
  }

  get(sourceId: number): ProgressSnapshot | null {
    return this.snapshots.get(sourceId) ?? null;
  }

  /** Drop the snapshot for a source — called at the start of a fresh run. */
  clear(sourceId: number): void {
    this.snapshots.delete(sourceId);
  }

  /** Diagnostic — how many sources have a recorded frame right now. */
  size(): number {
    return this.snapshots.size;
  }
}
