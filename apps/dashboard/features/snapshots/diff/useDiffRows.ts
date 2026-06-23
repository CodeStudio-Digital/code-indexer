/**
 * Flattens a `SnapshotFileDiff` (hunks → lines, with interspersed review
 * comments) into a single linear `DiffRow[]` so the viewer can drive one flat
 * virtualizer over the whole file instead of nested per-hunk lists.
 *
 * Comment resolution is bucketed by hunk fingerprint and then matched with the
 * exact same `matchesLine` predicate the old renderer used — this removes the
 * O(lines × allComments) scan that ran on every render (each line now only
 * checks its own hunk's handful of comments) while staying byte-faithful to the
 * previous anchoring semantics.
 */
import { useMemo } from 'react';
import type {
  SnapshotFileDiff,
  SnapshotHunk,
  SnapshotHunkLine,
  SnapshotReviewComment,
} from '../types.js';

const EMPTY: SnapshotReviewComment[] = [];

export function isVisibleComment(c: SnapshotReviewComment): boolean {
  return c.status !== 'dismissed' && c.status !== 'sent';
}

/** Same precedence as the legacy renderer: prefer the new-side anchor, then
 *  fall back to the old-side anchor. */
export function matchesLine(comment: SnapshotReviewComment, line: SnapshotHunkLine): boolean {
  if (!isVisibleComment(comment)) return false;
  if (comment.new_line != null && line.newLine != null) return comment.new_line === line.newLine;
  if (comment.old_line != null && line.oldLine != null) return comment.old_line === line.oldLine;
  return false;
}

export type DiffRow =
  | { kind: 'hunk-header'; key: string; hunk: SnapshotHunk; decided: boolean }
  | { kind: 'comment'; key: string; comment: SnapshotReviewComment; decided: boolean }
  | { kind: 'expand'; key: string; hunk: SnapshotHunk; side: 'before' | 'after'; decided: boolean }
  | { kind: 'line'; key: string; hunk: SnapshotHunk; line: SnapshotHunkLine; decided: boolean }
  | { kind: 'footer'; key: string; hunk: SnapshotHunk };

export interface DiffRowsResult {
  rows: DiffRow[];
  /** File-scoped comments (no hunk, no line) rendered above the diff body. */
  fileLevelComments: SnapshotReviewComment[];
  /** Widest line in characters — drives the horizontal scroll width estimate. */
  maxContentChars: number;
}

interface HunkComments {
  hunkLevel: SnapshotReviewComment[];
  lineLevel: SnapshotReviewComment[];
}

export function useDiffRows(
  diff: SnapshotFileDiff,
  comments: SnapshotReviewComment[],
): DiffRowsResult {
  return useMemo(() => {
    const baselineId = diff.baseline.id;

    // Partition this file's comments once: file-level vs per-hunk buckets.
    const fileLevelComments: SnapshotReviewComment[] = [];
    const byFp = new Map<string, HunkComments>();
    for (const c of comments) {
      if (c.baseline_id !== baselineId || !isVisibleComment(c)) continue;
      const fp = c.hunk_fingerprint;
      if (fp == null) {
        if (c.old_line == null && c.new_line == null) fileLevelComments.push(c);
        continue;
      }
      let bucket = byFp.get(fp);
      if (!bucket) {
        bucket = { hunkLevel: [], lineLevel: [] };
        byFp.set(fp, bucket);
      }
      if (c.old_line == null && c.new_line == null) bucket.hunkLevel.push(c);
      else bucket.lineLevel.push(c);
    }

    const rows: DiffRow[] = [];
    let maxContentChars = 0;
    for (const hunk of diff.hunks) {
      const fp = hunk.fingerprint;
      const decided = hunk.decision !== 'pending';
      const bucket = byFp.get(fp);
      rows.push({ kind: 'hunk-header', key: `h:${fp}`, hunk, decided });
      for (const c of bucket?.hunkLevel ?? EMPTY) {
        rows.push({ kind: 'comment', key: `c:${c.id}`, comment: c, decided });
      }
      if (hunk.canExpandBefore) {
        rows.push({ kind: 'expand', key: `xb:${fp}`, hunk, side: 'before', decided });
      }
      const lineLevel = bucket?.lineLevel ?? EMPTY;
      for (const line of hunk.lines) {
        if (line.content.length > maxContentChars) maxContentChars = line.content.length;
        rows.push({
          kind: 'line',
          key: `l:${fp}:${line.oldLine ?? 'a'}:${line.newLine ?? 'b'}`,
          hunk,
          line,
          decided,
        });
        if (lineLevel.length > 0) {
          for (const c of lineLevel) {
            if (matchesLine(c, line)) {
              rows.push({ kind: 'comment', key: `c:${c.id}`, comment: c, decided });
            }
          }
        }
      }
      if (hunk.canExpandAfter) {
        rows.push({ kind: 'expand', key: `xa:${fp}`, hunk, side: 'after', decided });
      }
      if (!decided) rows.push({ kind: 'footer', key: `f:${fp}`, hunk });
    }

    return { rows, fileLevelComments, maxContentChars };
  }, [diff, comments]);
}
