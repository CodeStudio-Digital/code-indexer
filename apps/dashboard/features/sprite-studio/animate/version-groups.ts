/**
 * Frames-browser grouping adapter. The backend `/generations` endpoint already
 * groups an asset's versions by generation batch (job_id) and resolves each
 * batch's animation name; this pure helper just resolves the member versionIds
 * to their AssetVersion rows (via the shared versionById map) and hands back a
 * render-ready view with a stable collapse key. Missing versions (map miss)
 * are dropped from `versions` but still counted in `count`.
 */
import type { AssetVersion } from '../types.js';
import type { GenerationGroup } from './api-anim-bulk.js';

export interface FrameGroupView {
  /** Stable across refetch — the collapse-state key. */
  key: string;
  jobId: string | null;
  kind: string;
  animationId: string | null;
  animationName: string | null;
  prompt: string | null;
  createdAt: string;
  /** Resolved rows, version-ascending (reads frame_1..frame_n). */
  versions: AssetVersion[];
  /** Authoritative member count (even if some rows didn't resolve yet). */
  count: number;
  /** Original combined sheet kept for this batch (re-sliceable). */
  hasSheet: boolean;
}

/** Mirror of the backend gridFor — the default grid a batch's sheet was cut on. */
export function gridFor(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n <= 3) return { cols: n, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 4, rows: Math.ceil(n / 4) };
}

/** The grid a batch's sheet was originally sliced on (anim = one row). */
export function defaultGridFor(group: FrameGroupView): { cols: number; rows: number } {
  return group.animationId != null ? { cols: group.count, rows: 1 } : gridFor(group.count);
}

export const frameGroupKey = (jobId: string | null): string => (jobId == null ? 'manual' : `job:${jobId}`);

export function buildFrameGroups(
  generations: GenerationGroup[],
  versionById: Map<string, AssetVersion>,
): FrameGroupView[] {
  return generations.map((g) => ({
    key: frameGroupKey(g.jobId),
    jobId: g.jobId,
    kind: g.kind,
    animationId: g.animationId,
    animationName: g.animationName,
    prompt: g.prompt,
    createdAt: g.createdAt,
    versions: g.versionIds
      .map((id) => versionById.get(id))
      .filter((v): v is AssetVersion => v != null),
    count: g.versionIds.length,
    hasSheet: g.hasSheet,
  }));
}
