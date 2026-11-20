import type { DirtyEvent, DirtyKind } from './types.js';

/**
 * Per-project pending-change set for the incremental drain. Deduped by
 * path; a later event overwrites the kind (unlink after change = delete).
 * Paths are normalized to the index form (relative, forward slashes) by
 * the caller — this structure is transport-dumb.
 */
export interface DirtyRecord { path: string; kind: DirtyKind; version: number }
export interface DirtyJournal {
  load(projectId: number): DirtyRecord[];
  put(projectId: number, entries: DirtyRecord[]): void;
  ack(projectId: number, entries: DirtyRecord[]): void;
  clear(projectId: number): void;
}
export interface DirtyBatch { upserts: string[]; deletes: string[]; total: number; entries: DirtyRecord[] }

export class DirtyQueue {
  private byProject = new Map<number, Map<string, DirtyRecord>>();
  private sequence = 0;
  constructor(private journal?: DirtyJournal) {}

  private entries(projectId: number): Map<string, DirtyRecord> {
    let map = this.byProject.get(projectId);
    if (!map) {
      map = new Map((this.journal?.load(projectId) ?? []).map((e) => [e.path, e]));
      for (const e of map.values()) this.sequence = Math.max(this.sequence, e.version);
      this.byProject.set(projectId, map);
    }
    return map;
  }

  add(projectId: number, events: readonly DirtyEvent[]): DirtyRecord[] {
    if (events.length === 0) return [];
    const map = this.entries(projectId);
    const entries = events.map((e) => ({ ...e, version: ++this.sequence }));
    // Persist before publishing. Unacknowledged work is replayed after restart.
    this.journal?.put(projectId, entries);
    for (const e of entries) map.set(e.path, e);
    return entries;
  }

  addMissing(projectId: number, events: readonly DirtyEvent[]): DirtyRecord[] {
    const map = this.entries(projectId);
    return this.add(projectId, events.filter((event) => !map.has(event.path)));
  }

  size(projectId: number): number {
    return this.entries(projectId).size;
  }

  /**
   * Snapshot up to max entries. Only ack removes them, after a successful commit.
   */
  takeBatch(projectId: number, max: number): DirtyBatch {
    const entries: DirtyRecord[] = [];
    for (const e of this.entries(projectId).values()) {
      if (entries.length >= max) break;
      entries.push(e);
    }
    return { entries, total: entries.length,
      upserts: entries.filter((e) => e.kind === 'upsert').map((e) => e.path),
      deletes: entries.filter((e) => e.kind === 'delete').map((e) => e.path) };
  }

  ack(projectId: number, batch: Pick<DirtyBatch, 'entries'>, failedPaths: readonly string[] = []): void {
    const failed = new Set(failedPaths);
    const entries = batch.entries.filter((e) => !failed.has(e.path));
    this.journal?.ack(projectId, entries);
    const map = this.entries(projectId);
    for (const e of entries) if (map.get(e.path)?.version === e.version) map.delete(e.path);
  }

  clear(projectId: number): void {
    this.journal?.clear(projectId);
    this.byProject.delete(projectId);
  }
}
