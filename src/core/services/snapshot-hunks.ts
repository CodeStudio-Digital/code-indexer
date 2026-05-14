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
 * The classic LCS-based algorithm is O(N*M) in space, which is fine for the
 * file sizes we cap at (4 MB → at most ~60k lines). For larger files the
 * SnapshotService marks them `oversized` and skips hunk computation.
 */

import { createHash } from 'node:crypto';

export interface HunkLine {
  /** 'context' = unchanged, 'add' = present in after only, 'remove' = present in before only. */
  type: 'context' | 'add' | 'remove';
  content: string;
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
}

/**
 * Normalize line endings to \n. We do NOT trim or modify content otherwise —
 * the raw bytes still live in `content_before`, this is only for diff.
 */
export function normalizeForDiff(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Split into lines preserving the trailing-newline distinction. */
function splitLines(s: string): string[] {
  if (s === '') return [];
  // We split on \n but keep track of whether the last line has no trailing
  // newline. For our diff purposes (line-grouped), we can drop the empty
  // final element introduced by a trailing \n.
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Compute the LCS table for two line arrays. Returns the table itself —
 * caller does the trace-back.
 */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const m = a.length;
  const n = b.length;
  // Single flat array for cache friendliness; index [i*(n+1)+j].
  const t = new Uint32Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1];
    const rowOffset = i * (n + 1);
    const prevRowOffset = (i - 1) * (n + 1);
    for (let j = 1; j <= n; j++) {
      if (ai === b[j - 1]) {
        t[rowOffset + j] = t[prevRowOffset + j - 1] + 1;
      } else {
        const up = t[prevRowOffset + j];
        const left = t[rowOffset + j - 1];
        t[rowOffset + j] = up >= left ? up : left;
      }
    }
  }
  return t;
}

type EditOp = { kind: 'eq' | 'del' | 'add'; line: string };

function traceback(a: string[], b: string[], t: Uint32Array): EditOp[] {
  const n = b.length;
  const ops: EditOp[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'eq', line: a[i - 1] });
      i--;
      j--;
    } else {
      const up = t[(i - 1) * (n + 1) + j];
      const left = t[i * (n + 1) + j - 1];
      if (up >= left) {
        ops.push({ kind: 'del', line: a[i - 1] });
        i--;
      } else {
        ops.push({ kind: 'add', line: b[j - 1] });
        j--;
      }
    }
  }
  while (i > 0) {
    ops.push({ kind: 'del', line: a[i - 1] });
    i--;
  }
  while (j > 0) {
    ops.push({ kind: 'add', line: b[j - 1] });
    j--;
  }
  return ops.reverse();
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
function groupIntoHunks(ops: EditOp[], context: number): Hunk[] {
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
      if (eqLen >= 2 * context && k < ops.length) {
        // Long enough gap → end this hunk before the eq block, leaving
        // `context` lines as trailing context.
        j = j + context;
        break;
      }
      // Otherwise absorb the eq block and continue.
      j = k;
    }
    const changeEnd = j;

    // Expand the start backward by `context` if possible.
    const hunkStart = Math.max(0, changeStart - context);
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
    let beforeContextHead: string[] = [];
    let afterContextHead: string[] = [];
    // Collect leading context.
    for (let p = hunkStart; p < changeStart; p++) {
      lines.push({ type: 'context', content: ops[p].line });
      oldLines++;
      newLines++;
      beforeContextHead.push(ops[p].line);
      afterContextHead.push(ops[p].line);
    }
    // Collect change region (changeStart..changeEnd).
    for (let p = changeStart; p < changeEnd; p++) {
      const op = ops[p];
      if (op.kind === 'eq') {
        lines.push({ type: 'context', content: op.line });
        oldLines++;
        newLines++;
      } else if (op.kind === 'del') {
        lines.push({ type: 'remove', content: op.line });
        removed.push(op.line);
        oldLines++;
      } else {
        lines.push({ type: 'add', content: op.line });
        added.push(op.line);
        newLines++;
      }
    }

    // Anchor uses 3 lines of leading context plus the index in the file for
    // disambiguation (otherwise identical hunks at different locations would
    // share fingerprints).
    const anchor = `${beforeAtStart}:${afterAtStart}:${beforeContextHead.slice(-3).join('\n')}`;
    hunks.push({
      fingerprint: fingerprint(removed, added, anchor),
      oldStart: beforeAtStart,
      oldLines,
      newStart: afterAtStart,
      newLines,
      lines,
      addedCount: added.length,
      removedCount: removed.length,
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
  context = 3,
): Hunk[] {
  const a = splitLines(normalizeForDiff(before ?? ''));
  const b = splitLines(normalizeForDiff(after ?? ''));
  if (a.length === 0 && b.length === 0) return [];
  if (a.join('\n') === b.join('\n')) return [];
  const t = lcsTable(a, b);
  const ops = traceback(a, b, t);
  return groupIntoHunks(ops, context);
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
