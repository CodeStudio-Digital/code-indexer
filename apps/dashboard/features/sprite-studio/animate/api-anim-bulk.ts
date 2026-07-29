/**
 * Curation + import API for the Frames browser — grouping, bulk delete and
 * sprite-sheet import. Split from api-anim.ts to keep each animation file small.
 * Direct fetch against `apiBaseUrl()` (same pattern as api.ts / api-anim.ts).
 */
import { apiBaseUrl } from '../../../lib/api-client.js';
import { dedupeInflight } from '../../../lib/api-cache.js';

/** A generation batch (versions sharing a job_id) for a browser group header. */
export interface GenerationGroup {
  /** null = the synthetic 'manual' bucket (hand-edited / imported / aligned). */
  jobId: string | null;
  kind: string;
  animationId: string | null;
  /** Resolved animation name, or null (job not anim-scoped / anim deleted). */
  animationName: string | null;
  prompt: string | null;
  frameCount: number;
  createdAt: string;
  /** Member version ids, version-ascending (reads frame_1..frame_n). */
  versionIds: string[];
  /** The original combined sheet was kept (re-sliceable) for this batch. */
  hasSheet: boolean;
}

export interface ResliceGrid {
  cols: number;
  rows: number;
  offsetX?: number;
  offsetY?: number;
  marginX?: number;
  marginY?: number;
  /** Per-cell manual nudge in source px (row-major) — lets a frame steal a
   *  neighbour's pixels when the uniform grid clips it. */
  offsets?: Array<{ dx: number; dy: number }>;
}

export interface BulkDeleteResult {
  deleted: string[];
  missing: string[];
  affectedAnimations: Array<{ id: string; name: string; removedFrames: number }>;
}

export interface ImportSheetResult {
  versionIds: string[];
  cellWidth: number;
  cellHeight: number;
}

const projectBase = (p: number) => `/api/sprite-studio/projects/${p}`;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

/** Versions of an asset grouped by generation batch (Frames-browser headers).
 *  In-flight dedupe: refresh chains from several rails can fire this GET for
 *  the same asset concurrently — share one request. */
export const listGenerations = (p: number, assetId: string): Promise<GenerationGroup[]> =>
  dedupeInflight(`sprite:generations:${p}:${assetId}`, () =>
    req<{ generations: GenerationGroup[] }>(`${projectBase(p)}/assets/${assetId}/generations`)
      .then((r) => r.generations));

/** Curation-delete many versions at once; reports which animations lost frames. */
export const bulkDeleteVersions = (p: number, versionIds: string[]): Promise<BulkDeleteResult> =>
  req<BulkDeleteResult>(`${projectBase(p)}/versions/bulk-delete`, {
    method: 'POST',
    body: JSON.stringify({ versionIds }),
  });

/** URL of a generation batch's persisted original sheet (usable in <img src>). */
export const jobSheetUrl = (p: number, jobId: string): string =>
  `${apiBaseUrl()}${projectBase(p)}/jobs/${jobId}/sheet`;

/** Re-slice a batch's original sheet with a custom grid → new frame versions. */
export const resliceSheet = (
  p: number,
  assetId: string,
  jobId: string,
  grid: ResliceGrid,
): Promise<{ versionIds: string[]; cellWidth: number; cellHeight: number }> =>
  req<{ versionIds: string[]; cellWidth: number; cellHeight: number }>(
    `${projectBase(p)}/assets/${assetId}/reslice-sheet`,
    { method: 'POST', body: JSON.stringify({ jobId, ...grid }) },
  );

/** Slice an uploaded sprite sheet into cols×rows 'imported' versions. */
export const importSheet = async (
  p: number,
  assetId: string,
  file: Blob,
  cols: number,
  rows: number,
): Promise<ImportSheetResult> => {
  const form = new FormData();
  form.append('file', file, 'sheet.png');
  form.append('cols', String(cols));
  form.append('rows', String(rows));
  const res = await fetch(`${apiBaseUrl()}${projectBase(p)}/assets/${assetId}/import-sheet`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  return (await res.json()) as ImportSheetResult;
};
