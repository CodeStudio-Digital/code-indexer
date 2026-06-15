/**
 * Shared text-similarity primitives for memory dedup + consolidation.
 *
 * Single source of truth: both the on-write dedup ({@link MemoryExtractor})
 * and the periodic consolidator's title-fallback clustering use these, so the
 * "what counts as a near-duplicate" rule lives in one place.
 */

/** Word-overlap (Jaccard-min) similarity of two titles, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size);
}

/** Cosine similarity of two equal-length vectors, 0..1 (assumes non-negative use). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
