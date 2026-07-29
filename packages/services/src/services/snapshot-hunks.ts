/**
 * Minimal LCS-based diff → hunk extractor for SessionSnapshotService.
 *
 * We deliberately avoid pulling a new runtime dependency (`diff`, `jsdiff`,
 * etc.) because we only need three things:
 *   - line-level edit script between baseline and current
 *   - grouped into hunks with N lines of context
 *   - each hunk gets a stable fingerprint (so per-hunk keep/undo decisions
 *     survive re-renders, but get invalidated when the agent re-edits the
 *     same region)
 *
 * The line-level edit script itself lives in `snapshot-line-diff.ts` — it is
 * the only CPU-bound part and is guarded against pathological allocations
 * there. This module is just the hunk grouping/fingerprinting on top.
 */

import { createHash } from 'node:crypto';
import { type EditOp, diffOps, normalizeForDiff, splitLines } from './snapshot-line-diff.js';

export { normalizeForDiff } from './snapshot-line-diff.js';

export interface HunkLine {
  /** 'context' = unchanged, 'add' = present in after only, 'remove' = present in before only. */
  type: 'context' | 'add' | 'remove';
  content: string;
  /** 1-based line number on the BEFORE side, absent for pure additions. */
  oldLine?: number;
  /** 1-based line number on the AFTER side, absent for pure removals. */
  newLine?: number;
}

export interface Hunk {
  /** Stable id for keep/undo persistence. Recomputed each render. */
  fingerprint: string;
  /** 1-based line number of the first context/remove line in the BEFORE side. */
  oldStart: number;
  oldLines: number;
  /** 1-based line number of the first context/add line in the AFTER side. */
  newStart: number;
  newLines: number;
  lines: HunkLine[];
  /** Convenience counters. */
  addedCount: number;
  removedCount: number;
  /** Unrendered unchanged lines available immediately before this hunk. */
  hiddenBefore: number;
  /** Unrendered unchanged lines available immediately after this hunk. */
  hiddenAfter: number;
  canExpandBefore: boolean;
  canExpandAfter: boolean;
}

function fingerprint(removedLines: string[], addedLines: string[], anchor: string): string {
  const h = createHash('md5');
  h.update(anchor);
  h.update('\x1f');
  h.update(removedLines.join('\n'));
  h.update('\x1f');
  h.update(addedLines.join('\n'));
  return h.digest('hex');
}

/**
 * Convert an edit script into grouped hunks with up to `context` lines of
 * unchanged context surrounding each change block.
 */
export interface ComputeHunksOptions {
  /** Symmetric context, used when side-specific values are omitted. */
  context?: number;
  contextBefore?: number;
  contextAfter?: number;
}

function countEqBackward(ops: EditOp[], fromExclusive: number): number {
  let count = 0;
  for (let i = fromExclusive - 1; i >= 0 && ops[i].kind === 'eq'; i--) count++;
  return count;
}

function countEqForward(ops: EditOp[], fromInclusive: number): number {
  let count = 0;
  for (let i = fromInclusive; i < ops.length && ops[i].kind === 'eq'; i++) count++;
  return count;
}

function lineNumbersAt(ops: EditOp[], index: number): { before: number; after: number } {
  let before = 1;
  let after = 1;
  for (let i = 0; i < index; i++) {
    const op = ops[i];
    if (op.kind === 'eq') {
      before++;
      after++;
    } else if (op.kind === 'del') {
      before++;
    } else {
      after++;
    }
  }
  return { before, after };
}

function groupIntoHunks(
  ops: EditOp[],
  contextBefore: number,
  contextAfter: number,
): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  let beforeLineNo = 1;
  let afterLineNo = 1;

  while (i < ops.length) {
    // Skip equals until we find a change.
    if (ops[i].kind === 'eq') {
      beforeLineNo++;
      afterLineNo++;
      i++;
      continue;
    }

    // Determine the range of ops belonging to this hunk, including context.
    const changeStart = i;
    // Walk forward while we're in a change or in a stretch of eq shorter than 2*context.
    let j = i;
    while (j < ops.length) {
      if (ops[j].kind !== 'eq') {
        j++;
        continue;
      }
      // Count consecutive eqs.
      let k = j;
      while (k < ops.length && ops[k].kind === 'eq') k++;
      const eqLen = k - j;
      if (eqLen > contextBefore + contextAfter && k < ops.length) {
        // Long enough gap → end this hunk before the eq block, leaving
        // the requested trailing context.
        j = j + contextAfter;
        break;
      }
      if (k === ops.length && eqLen > contextAfter) {
        // Final unchanged tail. Git-style diffs keep only the requested
        // context after the last edit, not the entire rest of the file.
        j = j + contextAfter;
        break;
      }
      // Otherwise absorb the eq block and continue.
      j = k;
    }
    const changeEnd = j;

    // Expand the start backward by `context` if possible.
    const hunkStart = Math.max(0, changeStart - contextBefore);
    // beforeLineNo / afterLineNo here point at op index `i`. We need to
    // recompute their values at `hunkStart` by walking back.
    let beforeAtStart = beforeLineNo;
    let afterAtStart = afterLineNo;
    for (let back = i - 1; back >= hunkStart; back--) {
      const op = ops[back];
      if (op.kind === 'eq') {
        beforeAtStart--;
        afterAtStart--;
      } else if (op.kind === 'del') {
        beforeAtStart--;
      } else if (op.kind === 'add') {
        afterAtStart--;
      }
    }

    const lines: HunkLine[] = [];
    const removed: string[] = [];
    const added: string[] = [];
    let oldLines = 0;
    let newLines = 0;
    let oldCursor = beforeAtStart;
    let newCursor = afterAtStart;
    // Collect leading context.
    for (let p = hunkStart; p < changeStart; p++) {
      lines.push({
        type: 'context',
        content: ops[p].line,
        oldLine: oldCursor,
        newLine: newCursor,
      });
      oldCursor++;
      newCursor++;
      oldLines++;
      newLines++;
    }
    // Collect change region (changeStart..changeEnd).
    for (let p = changeStart; p < changeEnd; p++) {
      const op = ops[p];
      if (op.kind === 'eq') {
        lines.push({ type: 'context', content: op.line, oldLine: oldCursor, newLine: newCursor });
        oldCursor++;
        newCursor++;
        oldLines++;
        newLines++;
      } else if (op.kind === 'del') {
        lines.push({ type: 'remove', content: op.line, oldLine: oldCursor });
        oldCursor++;
        removed.push(op.line);
        oldLines++;
      } else {
        lines.push({ type: 'add', content: op.line, newLine: newCursor });
        newCursor++;
        added.push(op.line);
        newLines++;
      }
    }

    // Anchor uses 3 lines of leading context plus the index in the file for
    // disambiguation (otherwise identical hunks at different locations would
    // share fingerprints).
    const fingerprintStart = Math.max(0, changeStart - 3);
    const fpLines = lineNumbersAt(ops, fingerprintStart);
    const fpContext = ops
      .slice(fingerprintStart, changeStart)
      .filter((op) => op.kind === 'eq')
      .map((op) => op.line);
    const anchor = `${fpLines.before}:${fpLines.after}:${fpContext.slice(-3).join('\n')}`;
    const hiddenBefore = countEqBackward(ops, hunkStart);
    const hiddenAfter = countEqForward(ops, changeEnd);
    hunks.push({
      fingerprint: fingerprint(removed, added, anchor),
      oldStart: beforeAtStart,
      oldLines,
      newStart: afterAtStart,
      newLines,
      lines,
      addedCount: added.length,
      removedCount: removed.length,
      hiddenBefore,
      hiddenAfter,
      canExpandBefore: hiddenBefore > 0,
      canExpandAfter: hiddenAfter > 0,
    });

    // Advance counters to where we stopped, then continue.
    for (let p = i; p < changeEnd; p++) {
      const op = ops[p];
      if (op.kind === 'eq') {
        beforeLineNo++;
        afterLineNo++;
      } else if (op.kind === 'del') {
        beforeLineNo++;
      } else {
        afterLineNo++;
      }
    }
    i = changeEnd;
  }

  return hunks;
}

/**
 * Top-level: compute hunks between two strings. Both are normalized to \n
 * before diffing. Returns an empty array when the inputs are equal.
 *
 * `null` for `before` (file didn't exist) is treated as empty string — the
 * resulting hunk will be a pure-add. Symmetric for `after = null` (file was
 * deleted) → pure-remove.
 */
export function computeHunks(
  before: string | null,
  after: string | null,
  options: number | ComputeHunksOptions = 3,
): Hunk[] {
  const context =
    typeof options === 'number' ? options : options.context ?? 3;
  const contextBefore =
    typeof options === 'number' ? context : options.contextBefore ?? context;
  const contextAfter =
    typeof options === 'number' ? context : options.contextAfter ?? context;
  const a = splitLines(normalizeForDiff(before ?? ''));
  const b = splitLines(normalizeForDiff(after ?? ''));
  if (a.length === 0 && b.length === 0) return [];
  if (a.join('\n') === b.join('\n')) return [];
  const ops = diffOps(a, b);
  return groupIntoHunks(ops, Math.max(0, contextBefore), Math.max(0, contextAfter));
}

/**
 * Apply a *revert* of a single hunk: take the current file content, replace
 * the after-side of the hunk with the before-side, return the resulting
 * content. Returns `null` if the hunk can no longer be located (the file
 * has moved on too much). Caller should treat that as a stale-fingerprint
 * race and recompute.
 */
export function applyHunkRevert(
  baselineContent: string | null,
  currentContent: string,
  hunk: Hunk,
): string | null {
  const cur = splitLines(normalizeForDiff(currentContent));
  // The hunk's newStart/newLines tell us where on the AFTER side it sits.
  const start = hunk.newStart - 1; // to 0-based
  const end = start + hunk.newLines;
  if (start < 0 || end > cur.length) return null;
  // The block we'd replace must currently look like the hunk's "after"
  // projection (context + adds).
  const expectedAfter = hunk.lines
    .filter((l) => l.type === 'context' || l.type === 'add')
    .map((l) => l.content);
  for (let k = 0; k < expectedAfter.length; k++) {
    if (cur[start + k] !== expectedAfter[k]) return null;
  }
  // Replacement is the before projection (context + removes).
  const replacement = hunk.lines
    .filter((l) => l.type === 'context' || l.type === 'remove')
    .map((l) => l.content);
  const result = [...cur.slice(0, start), ...replacement, ...cur.slice(end)];
  return result.join('\n') + (currentContent.endsWith('\n') ? '\n' : '');
}

/**
 * Conflict-safe variant used by historical round rollback. It first tries the
 * original position, then relocates the exact after-side projection only when
 * it occurs once in the current file. This preserves later edits that merely
 * shifted the hunk while refusing ambiguous/overlapping changes.
 */
export function applyHunkRevertFlexible(
  baselineContent: string | null,
  currentContent: string,
  hunk: Hunk,
): string | null {
  const positional = applyHunkRevert(baselineContent, currentContent, hunk);
  if (positional != null) return positional;

  const cur = splitLines(normalizeForDiff(currentContent));
  const firstChange = hunk.lines.findIndex((line) => line.type !== 'context');
  let lastChange = -1;
  for (let index = hunk.lines.length - 1; index >= 0; index--) {
    if (hunk.lines[index].type !== 'context') {
      lastChange = index;
      break;
    }
  }
  if (firstChange < 0 || lastChange < firstChange) return null;
  // Ignore leading/trailing display context when locating the actual edited
  // span. A later round may legitimately change an adjacent context line;
  // that must not turn a non-overlapping rollback into a false conflict.
  const changeRegion = hunk.lines.slice(firstChange, lastChange + 1);
  const expectedAfter = changeRegion
    .filter((line) => line.type === 'context' || line.type === 'add')
    .map((line) => line.content);
  const replacement = changeRegion
    .filter((line) => line.type === 'context' || line.type === 'remove')
    .map((line) => line.content);

  if (expectedAfter.length === 0) {
    // Pure deletion: relocate the insertion boundary using the strongest
    // surviving context on either side. Requiring one unique best boundary
    // prevents a common line elsewhere in the file from receiving the text.
    const leading = hunk.lines.slice(0, firstChange).map((line) => line.content);
    const trailing = hunk.lines.slice(lastChange + 1).map((line) => line.content);
    let bestScore = 0;
    const bestBoundaries: number[] = [];
    for (let boundary = 0; boundary <= cur.length; boundary++) {
      let leftScore = 0;
      for (let size = 1; size <= Math.min(leading.length, boundary); size++) {
        const anchor = leading.slice(leading.length - size);
        if (anchor.every((line, index) => cur[boundary - size + index] === line)) {
          leftScore = size;
        }
      }
      let rightScore = 0;
      for (let size = 1; size <= Math.min(trailing.length, cur.length - boundary); size++) {
        if (trailing.slice(0, size).every((line, index) => cur[boundary + index] === line)) {
          rightScore = size;
        }
      }
      const score = leftScore + rightScore;
      if (score > bestScore) {
        bestScore = score;
        bestBoundaries.length = 0;
        bestBoundaries.push(boundary);
      } else if (score > 0 && score === bestScore) {
        bestBoundaries.push(boundary);
      }
    }
    if (bestScore === 0 || bestBoundaries.length !== 1) return null;
    const boundary = bestBoundaries[0];
    const result = [...cur.slice(0, boundary), ...replacement, ...cur.slice(boundary)];
    return result.join('\n') + (currentContent.endsWith('\n') ? '\n' : '');
  }
  if (expectedAfter.length > cur.length) return null;

  const matches: number[] = [];
  outer: for (let start = 0; start <= cur.length - expectedAfter.length; start++) {
    for (let offset = 0; offset < expectedAfter.length; offset++) {
      if (cur[start + offset] !== expectedAfter[offset]) continue outer;
    }
    matches.push(start);
    if (matches.length > 1) return null;
  }
  if (matches.length !== 1) return null;

  const start = matches[0];
  const result = [
    ...cur.slice(0, start),
    ...replacement,
    ...cur.slice(start + expectedAfter.length),
  ];
  return result.join('\n') + (currentContent.endsWith('\n') ? '\n' : '');
}
