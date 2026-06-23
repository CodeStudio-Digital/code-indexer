/**
 * Retrieval-quality metrics for the doc-RAG eval harness (scripts/docs-rag-eval.ts).
 *
 * Kept pure + dependency-free so they're unit-tested without a database: the
 * runner does the I/O (open DB, run DocHybridSearch), these functions turn a
 * ranked result list + a gold relevance spec into R@k / nDCG@k / MRR.
 *
 * Relevance is matched by SOURCE (source_uri substring) and/or HEADING
 * substring — NOT chunk_id, which is DB-specific and rotates on re-index, so a
 * gold-set stays valid across re-indexing.
 */

/**
 * One gold relevance entry = ONE distinct expected document. The two optional
 * fields are ANDed (a result must satisfy both when both are present). Use
 * NON-OVERLAPPING entries across a query's gold list — each entry is counted
 * as a separate relevant doc for recall/nDCG (see labelRanked). Prefer
 * `source_uri_contains` (precise, stable) over `heading_contains` (looser).
 */
export interface RelevantSpec {
  /** Result matches if its source_uri CONTAINS this substring. */
  source_uri_contains?: string;
  /** Result matches if its heading_path contains this substring (case-insensitive). */
  heading_contains?: string;
}

export interface EvalResultRef {
  source_uri: string | null;
  heading_path: string | null;
}

/** Does one ranked result satisfy a gold relevance spec? Empty spec → false. */
export function matchesSpec(r: EvalResultRef, spec: RelevantSpec): boolean {
  if (!spec.source_uri_contains && !spec.heading_contains) return false;
  if (spec.source_uri_contains) {
    if (!r.source_uri || !r.source_uri.includes(spec.source_uri_contains)) return false;
  }
  if (spec.heading_contains) {
    const h = (r.heading_path ?? '').toLowerCase();
    if (!h.includes(spec.heading_contains.toLowerCase())) return false;
  }
  return true;
}

/**
 * Map ranked results to a relevance boolean per position. Each gold entry (a
 * distinct expected doc) is credited AT MOST ONCE — to the first result that
 * satisfies it — so several retrieved chunks of the same page don't inflate
 * recall. Assumes non-overlapping gold entries (one matcher per expected doc).
 */
export function labelRanked(results: EvalResultRef[], gold: RelevantSpec[]): boolean[] {
  const used = new Array(gold.length).fill(false);
  return results.map((r) => {
    for (let g = 0; g < gold.length; g++) {
      if (!used[g] && matchesSpec(r, gold[g]!)) {
        used[g] = true;
        return true;
      }
    }
    return false;
  });
}

/** 1 if any relevant result appears in the top k, else 0 (a.k.a. success@k). */
export function successAtK(ranked: boolean[], k: number): number {
  return ranked.slice(0, k).some(Boolean) ? 1 : 0;
}

/** Fraction of the gold set retrieved in the top k. */
export function recallAtK(ranked: boolean[], k: number, numRelevant: number): number {
  if (numRelevant <= 0) return 0;
  const hits = ranked.slice(0, k).filter(Boolean).length;
  return hits / numRelevant;
}

/** Reciprocal rank of the first relevant result (0 if none). */
export function mrr(ranked: boolean[]): number {
  const idx = ranked.findIndex(Boolean);
  return idx < 0 ? 0 : 1 / (idx + 1);
}

/** Binary-gain nDCG@k, normalised by the ideal ranking of `numRelevant` hits. */
export function ndcgAtK(ranked: boolean[], k: number, numRelevant: number): number {
  const dcg = ranked
    .slice(0, k)
    .reduce((acc, rel, i) => acc + (rel ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Math.min(numRelevant, k);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
