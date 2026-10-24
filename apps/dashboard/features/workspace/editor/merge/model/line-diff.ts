/**
 * Self-contained line-level diff (no external dep). Returns aligned segments
 * of equal / delete (in base, gone in other) / insert (added in other) over
 * EOL-normalized line arrays. Common prefix/suffix are trimmed first (the
 * usual "small edit in a big file" case stays O(n)); the remaining middle is
 * an LCS DP, guarded so a pathological middle degrades to a coarse replace
 * instead of blowing memory.
 */

interface LineSegment {
  kind: 'equal' | 'delete' | 'insert';
  // half-open [start, end) over the normalized line arrays.
  baseStart: number;
  baseEnd: number; // 'insert' → baseStart === baseEnd
  otherStart: number;
  otherEnd: number; // 'delete' → otherStart === otherEnd
}

const MAX_DP_CELLS = 4_000_000;

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Split into lines, dropping the artifact empty element from a trailing '\n'. */
export function splitLines(s: string): string[] {
  const n = normalizeEol(s);
  if (n === '') return [];
  const parts = n.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function diffLines(base: string, other: string): LineSegment[] {
  const a = splitLines(base);
  const b = splitLines(other);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const segs: LineSegment[] = [];
  if (p > 0) segs.push({ kind: 'equal', baseStart: 0, baseEnd: p, otherStart: 0, otherEnd: p });
  segs.push(...diffMiddle(a, b, p, a.length - s, p, b.length - s));
  if (s > 0) {
    segs.push({ kind: 'equal', baseStart: a.length - s, baseEnd: a.length, otherStart: b.length - s, otherEnd: b.length });
  }
  return mergeAdjacent(segs);
}

function diffMiddle(a: string[], b: string[], aLo: number, aHi: number, bLo: number, bHi: number): LineSegment[] {
  const m = aHi - aLo;
  const n = bHi - bLo;
  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ kind: 'insert', baseStart: aLo, baseEnd: aLo, otherStart: bLo, otherEnd: bHi }];
  if (n === 0) return [{ kind: 'delete', baseStart: aLo, baseEnd: aHi, otherStart: bLo, otherEnd: bLo }];
  if (m * n > MAX_DP_CELLS) {
    return [
      { kind: 'delete', baseStart: aLo, baseEnd: aHi, otherStart: bLo, otherEnd: bLo },
      { kind: 'insert', baseStart: aHi, baseEnd: aHi, otherStart: bLo, otherEnd: bHi },
    ];
  }
  // LCS length table (row i+1 depends on i+1/i), backtracked greedily.
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[aLo + i] === b[bLo + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: LineSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[aLo + i] === b[bLo + j]) {
      out.push({ kind: 'equal', baseStart: aLo + i, baseEnd: aLo + i + 1, otherStart: bLo + j, otherEnd: bLo + j + 1 });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'delete', baseStart: aLo + i, baseEnd: aLo + i + 1, otherStart: bLo + j, otherEnd: bLo + j });
      i++;
    } else {
      out.push({ kind: 'insert', baseStart: aLo + i, baseEnd: aLo + i, otherStart: bLo + j, otherEnd: bLo + j + 1 });
      j++;
    }
  }
  // Trailing deletes occur after the other side is exhausted (j === n): anchor
  // them at the CONSUMED other position (bLo + j), not bLo, or otherAt() under-
  // counts and later regions re-slice already-consumed lines (line duplication).
  while (i < m) { out.push({ kind: 'delete', baseStart: aLo + i, baseEnd: aLo + i + 1, otherStart: bLo + j, otherEnd: bLo + j }); i++; }
  while (j < n) { out.push({ kind: 'insert', baseStart: aLo + i, baseEnd: aLo + i, otherStart: bLo + j, otherEnd: bLo + j + 1 }); j++; }
  return out;
}

/** Coalesce consecutive same-kind, contiguous segments. */
function mergeAdjacent(segs: LineSegment[]): LineSegment[] {
  const out: LineSegment[] = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.kind === seg.kind && last.baseEnd === seg.baseStart && last.otherEnd === seg.otherStart) {
      last.baseEnd = seg.baseEnd;
      last.otherEnd = seg.otherEnd;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

export interface ChangeBlock {
  baseStart: number;
  baseEnd: number;
  otherStart: number;
  otherEnd: number;
}

interface Span extends ChangeBlock {
  kind: 'equal' | 'change';
}

/**
 * Coalesce raw segments into a partition of base where every non-equal run
 * (delete / insert / replace = delete+insert) becomes ONE `change` span. This
 * anchors a replace's inserted lines at the deleted lines' base position
 * (not after them), which `otherAt` relies on for a correct base→other map.
 */
export function spansOf(segs: LineSegment[]): Span[] {
  const out: Span[] = [];
  for (const seg of segs) {
    const kind: Span['kind'] = seg.kind === 'equal' ? 'equal' : 'change';
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.baseEnd === seg.baseStart && last.otherEnd === seg.otherStart) {
      last.baseEnd = seg.baseEnd;
      last.otherEnd = seg.otherEnd;
    } else {
      out.push({ kind, baseStart: seg.baseStart, baseEnd: seg.baseEnd, otherStart: seg.otherStart, otherEnd: seg.otherEnd });
    }
  }
  return out;
}

/**
 * Other-line index corresponding to base position `b` (count of `other` lines
 * for base `[0,b)`), computed over coalesced spans. A change span ending at
 * `b` is counted; a span starting at `b` is not (it belongs to the region
 * starting at `b`).
 */
export function otherAt(b: number, spans: Span[]): number {
  let other = 0;
  for (const s of spans) {
    if (s.baseStart >= b) break;
    if (s.baseEnd <= b) other += s.otherEnd - s.otherStart;
    else {
      if (s.kind === 'equal') other += b - s.baseStart;
      break;
    }
  }
  return other;
}

/** The non-equal (replace) blocks of a span list. */
export function changeBlocks(spans: Span[]): ChangeBlock[] {
  return spans
    .filter((s) => s.kind === 'change')
    .map((s) => ({ baseStart: s.baseStart, baseEnd: s.baseEnd, otherStart: s.otherStart, otherEnd: s.otherEnd }));
}
