/**
 * Copilot-style "fixed window Jaccard matcher": slide a 60-line window over a
 * candidate file and score each window's token-set overlap against a
 * reference window around the cursor. Incremental: sliding by one line only
 * adds/removes that line's tokens from a multiset — O(lines × tokens/line),
 * not O(windows × window size).
 */

export const WINDOW_LINES = 60;
// No `$` in the charset: PHP `$total` and a `->total` property access must
// yield the same token for cross-file similarity to see them as related.
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
/** Tokens this short are noise (`a`, `if`, `id`) — skip. */
const MIN_TOKEN_LEN = 3;

export function tokenizeLine(line: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(line))) {
    const t = m[0]!.toLowerCase();
    if (t.length >= MIN_TOKEN_LEN) out.push(t);
  }
  return out;
}

export function tokenSet(lines: string[]): Set<string> {
  const s = new Set<string>();
  for (const l of lines) for (const t of tokenizeLine(l)) s.add(t);
  return s;
}

/** |A∩B| / |A∪B| over token sets. */
function jaccard(refSet: Set<string>, counts: Map<string, number>): number {
  if (refSet.size === 0 || counts.size === 0) return 0;
  let inter = 0;
  for (const t of counts.keys()) if (refSet.has(t)) inter++;
  const union = refSet.size + counts.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface WindowMatch {
  startLine: number; // 1-based, inclusive
  endLine: number;   // 1-based, inclusive
  score: number;
}

/**
 * Best WINDOW_LINES-line window of `lines` by Jaccard similarity against
 * `refSet`. Multiset counts keep distinct-token membership exact while
 * sliding. Returns null when nothing scores above zero.
 */
export function bestWindow(lines: string[], refSet: Set<string>, windowLines = WINDOW_LINES): WindowMatch | null {
  if (lines.length === 0 || refSet.size === 0) return null;
  const perLine: string[][] = lines.map(tokenizeLine);
  const win = Math.min(windowLines, lines.length);
  const counts = new Map<string, number>();
  const add = (toks: string[]) => {
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
  };
  const remove = (toks: string[]) => {
    for (const t of toks) {
      const n = counts.get(t)!;
      if (n <= 1) counts.delete(t);
      else counts.set(t, n - 1);
    }
  };

  for (let i = 0; i < win; i++) add(perLine[i]!);
  let best: WindowMatch = { startLine: 1, endLine: win, score: jaccard(refSet, counts) };
  for (let start = 1; start + win <= lines.length; start++) {
    remove(perLine[start - 1]!);
    add(perLine[start + win - 1]!);
    const score = jaccard(refSet, counts);
    if (score > best.score) best = { startLine: start + 1, endLine: start + win, score };
  }
  return best.score > 0 ? best : null;
}
