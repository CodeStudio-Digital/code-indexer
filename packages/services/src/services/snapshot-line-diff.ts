/**
 * Line-level edit script (LCS) for the snapshot hunk extractor.
 *
 * Split out of `snapshot-hunks.ts` so the CPU-bound part is a self-contained,
 * dependency-free module: it takes two strings and returns ops, which makes it
 * cheap to hand to a worker thread later.
 *
 * The classic LCS DP is O(N*M) in *space*. The old header claimed that was
 * "fine for the file sizes we cap at (4 MB → at most ~60k lines)", but that
 * conflates file size with table size: two unrelated 60k-line files ask for
 * 60k * 60k * 4 bytes = ~14 GB. Since this runs in the Electron main process,
 * that is a window-freezing allocation, not just a slow one. Hence the two
 * mitigations below, both copied from the renderer's merge view
 * (apps/dashboard/features/workspace/editor/merge/model/line-diff.ts):
 *   1. trim the common prefix/suffix first — the usual "small edit in a big
 *      file" case never builds a table at all;
 *   2. cap the remaining middle at MAX_DP_CELLS and degrade to a coarse
 *      replace beyond it.
 */

/**
 * 4M cells = 16 MB as a Uint32Array. Same constant as the renderer's merge
 * view so both sides degrade at the same input size.
 */
export const MAX_DP_CELLS = 4_000_000;

export type EditOp = { kind: 'eq' | 'del' | 'add'; line: string };

/**
 * Normalize line endings to \n. We do NOT trim or modify content otherwise —
 * the raw bytes still live in `content_before`, this is only for diff.
 */
export function normalizeForDiff(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Split into lines preserving the trailing-newline distinction. */
export function splitLines(s: string): string[] {
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
 * caller does the trace-back. Only called for a middle already known to fit
 * within MAX_DP_CELLS.
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

/**
 * Ops for the differing middle only. Degrades to a coarse
 * delete-everything/add-everything replace when the table would be too big —
 * the diff stays *correct* (applying it still reproduces `b`), it just stops
 * being minimal for pathological inputs.
 */
function middleOps(a: string[], b: string[]): EditOp[] {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return b.map((line): EditOp => ({ kind: 'add', line }));
  if (b.length === 0) return a.map((line): EditOp => ({ kind: 'del', line }));
  if ((a.length + 1) * (b.length + 1) > MAX_DP_CELLS) {
    return [
      ...a.map((line): EditOp => ({ kind: 'del', line })),
      ...b.map((line): EditOp => ({ kind: 'add', line })),
    ];
  }
  return traceback(a, b, lcsTable(a, b));
}

/**
 * Full edit script between two line arrays. Common prefix/suffix are matched
 * directly (they are always part of *some* LCS, so this cannot change the
 * result for those regions) and only the middle pays for the DP.
 */
export function diffOps(a: string[], b: string[]): EditOp[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const head = a.slice(0, p).map((line): EditOp => ({ kind: 'eq', line }));
  const tail = a.slice(a.length - s).map((line): EditOp => ({ kind: 'eq', line }));
  return [...head, ...middleOps(a.slice(p, a.length - s), b.slice(p, b.length - s)), ...tail];
}
