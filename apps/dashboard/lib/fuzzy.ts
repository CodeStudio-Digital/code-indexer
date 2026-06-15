/**
 * Tiny path/title ranking shared by Search Everywhere and Quick Open:
 * substring match position + basename bonus, subsequence fallback so
 * initials work ("wstx" → Workspace.tsx). Lower score = better; null = no
 * match.
 */
export function rankPath(path: string, q: string): number | null {
  if (!q) return path.length;
  const lower = path.toLowerCase();
  const qLower = q.toLowerCase();
  const ix = lower.indexOf(qLower);
  if (ix < 0) {
    let li = 0;
    let qi = 0;
    while (li < lower.length && qi < qLower.length) {
      if (lower[li] === qLower[qi]) qi += 1;
      li += 1;
    }
    if (qi < qLower.length) return null;
    return 100_000 + path.length;
  }
  const slashIx = lower.lastIndexOf('/', ix);
  const basenameMatch = ix === slashIx + 1;
  let score = ix * 2 + path.length;
  if (basenameMatch) score -= 1000;
  return score;
}
