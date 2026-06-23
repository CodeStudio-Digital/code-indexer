/**
 * Closest-match suggestion for unknown tool names.
 *
 * Models occasionally invent or shorten a tool name — telemetry caught
 * `grep_code` for the real `mcp__grep_code`. A bare "Unknown tool: X" gives
 * the model nothing to recover with; a deterministic "did you mean" pointer
 * turns the failure into a one-turn fix.
 *
 * Matching tiers, in order:
 *   1. case-insensitive exact;
 *   2. namespace-blind match — compare the last `__`-segment of both names,
 *      covering `grep_code` ↔ `mcp__grep_code` ↔ `mcp__<server>__grep_code`
 *      and `ext_<plugin>__` tools in either direction;
 *   3. banded Levenshtein (≤2 for names under 10 chars, ≤3 otherwise).
 *
 * Ties resolve to the lexicographically smallest candidate so the output is
 * deterministic (markers/refusals must stay prefix-cache stable).
 */

/** Last `__`-separated segment, lowercased — the namespace-blind "bare" name. */
function bareName(name: string): string {
  const segments = name.toLowerCase().split('__');
  return segments[segments.length - 1] ?? name.toLowerCase();
}

/**
 * Levenshtein distance with a cutoff: returns `cutoff + 1` as soon as the
 * distance provably exceeds `cutoff` (cheap row-minimum early exit).
 */
function boundedLevenshtein(a: string, b: string, cutoff: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cutoff) return cutoff + 1;
    prev = curr;
  }
  return prev[b.length];
}

/**
 * Best registered-tool suggestion for an unknown name, or null when nothing
 * is plausibly close. Pure and deterministic over its inputs.
 */
export function suggestToolName(unknown: string, known: ReadonlyArray<string>): string | null {
  if (!unknown || known.length === 0) return null;
  const sorted = [...known].sort();
  const lower = unknown.toLowerCase();

  for (const k of sorted) {
    if (k.toLowerCase() === lower) return k;
  }

  const bare = bareName(unknown);
  for (const k of sorted) {
    if (bareName(k) === bare) return k;
  }

  const cutoff = unknown.length < 10 ? 2 : 3;
  let best: string | null = null;
  let bestDist = cutoff + 1;
  for (const k of sorted) {
    const d = boundedLevenshtein(lower, k.toLowerCase(), cutoff);
    if (d < bestDist) {
      bestDist = d;
      best = k; // sorted iteration → first hit at a distance is the lexicographic smallest
    }
  }
  return bestDist <= cutoff ? best : null;
}
