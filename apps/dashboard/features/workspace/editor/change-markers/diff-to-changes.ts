/**
 * The IntelliJ "Line Status Tracker" model: turn a (baseline, current) pair
 * into the change blocks the gutter paints. Pure — reuses the merge editor's
 * dependency-free LCS diff (`diffLines` → `spansOf` → `changeBlocks`), so the
 * same coords (0-based, half-open over EOL-normalized line arrays) flow
 * straight through.
 *
 *   - `added`    — lines only in the current buffer (base side empty)
 *   - `deleted`  — lines only in the baseline (current side empty)
 *   - `modified` — both sides non-empty (a replace)
 */

import { diffLines, splitLines, spansOf, changeBlocks } from '../merge/model/line-diff.js';

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface Change {
  kind: ChangeKind;
  /** Half-open [baseStart, baseEnd) over the baseline's normalized lines. */
  baseStart: number;
  baseEnd: number;
  /** Half-open [otherStart, otherEnd) over the current buffer's lines. */
  otherStart: number;
  otherEnd: number;
  /** Baseline (HEAD) text for this block — drives rollback / preview / copy. */
  baselineText: string;
}

export function computeChanges(baseline: string, current: string): Change[] {
  const baseLines = splitLines(baseline);
  const blocks = changeBlocks(spansOf(diffLines(baseline, current)));
  return blocks.map((b) => {
    const hasCurrent = b.otherEnd > b.otherStart;
    const hasBase = b.baseEnd > b.baseStart;
    const kind: ChangeKind = !hasCurrent ? 'deleted' : hasBase ? 'modified' : 'added';
    return {
      kind,
      baseStart: b.baseStart,
      baseEnd: b.baseEnd,
      otherStart: b.otherStart,
      otherEnd: b.otherEnd,
      baselineText: baseLines.slice(b.baseStart, b.baseEnd).join('\n'),
    };
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/**
 * 1-based line the gutter marker / toolbar anchors to. For added & modified
 * blocks it's the first changed line; for a deletion it's the line that now
 * sits just below the removed text (clamped to the last line at EOF).
 */
export function anchorLine(change: Change, lineCount: number): number {
  return clamp(change.otherStart + 1, 1, Math.max(1, lineCount));
}

/** Whether a 1-based line falls inside the block's painted gutter range. */
export function changeCoversLine(change: Change, line: number, lineCount: number): boolean {
  if (change.kind === 'deleted') return line === anchorLine(change, lineCount);
  const start = clamp(change.otherStart + 1, 1, lineCount);
  const end = clamp(change.otherEnd, 1, lineCount);
  return line >= start && line <= end;
}
