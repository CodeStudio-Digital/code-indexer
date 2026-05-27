/**
 * Minimal unified-diff between two strings, line-based, with `contextLines`
 * of unchanged context around each hunk. No external deps — uses a simple
 * LCS via DP. Caller is expected to keep inputs under a few thousand lines
 * (the read tool already enforces caps).
 *
 * Determinism: identical (before, after, contextLines) → identical output,
 * so safe to embed in tool_result content without busting prompt cache.
 */
export function buildSimpleLineDiff(
  before: string,
  after: string,
  contextLines = 3,
): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  // Guard against pathological inputs.
  if (m * n > 4_000_000) {
    return `[diff suppressed: ${m}×${n} too large to compute inline; full content follows]`;
  }
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk back to produce an edit script.
  type Op = { kind: ' ' | '-' | '+'; aIdx?: number; bIdx?: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', aIdx: i, bIdx: j });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: '-', aIdx: i });
      i++;
    } else {
      ops.push({ kind: '+', bIdx: j });
      j++;
    }
  }
  while (i < m) ops.push({ kind: '-', aIdx: i++ });
  while (j < n) ops.push({ kind: '+', bIdx: j++ });

  if (!ops.some((o) => o.kind !== ' ')) return '(no changes)';

  // Group ops into hunks with `contextLines` of surrounding context.
  interface Hunk { aStart: number; aLen: number; bStart: number; bLen: number; lines: string[]; }
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let runOfContext = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind === ' ') {
      if (cur) {
        cur.lines.push(' ' + a[op.aIdx!]);
        cur.aLen++; cur.bLen++;
        runOfContext++;
        if (runOfContext > contextLines * 2) {
          // Trim trailing context, close hunk.
          const trim = runOfContext - contextLines;
          cur.lines.splice(cur.lines.length - trim, trim);
          cur.aLen -= trim; cur.bLen -= trim;
          hunks.push(cur);
          cur = null;
          runOfContext = 0;
        }
      }
    } else {
      if (!cur) {
        // Open a new hunk with up to contextLines of preceding context.
        const ctxStart = Math.max(0, k - contextLines);
        cur = { aStart: 0, bStart: 0, aLen: 0, bLen: 0, lines: [] };
        // Find absolute a/b indices at ctxStart.
        let aAt = 0, bAt = 0;
        for (let p = 0; p < ctxStart; p++) {
          if (ops[p].kind !== '+') aAt++;
          if (ops[p].kind !== '-') bAt++;
        }
        cur.aStart = aAt + 1; // 1-indexed
        cur.bStart = bAt + 1;
        for (let p = ctxStart; p < k; p++) {
          const o = ops[p];
          if (o.kind === ' ') {
            cur.lines.push(' ' + a[o.aIdx!]);
            cur.aLen++; cur.bLen++;
          }
        }
      }
      if (op.kind === '-') {
        cur.lines.push('-' + a[op.aIdx!]);
        cur.aLen++;
      } else {
        cur.lines.push('+' + b[op.bIdx!]);
        cur.bLen++;
      }
      runOfContext = 0;
    }
  }
  if (cur) hunks.push(cur);

  if (hunks.length === 0) return '(no changes)';

  const out: string[] = [];
  for (const h of hunks) {
    out.push(`@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@`);
    out.push(...h.lines);
  }
  return out.join('\n');
}
