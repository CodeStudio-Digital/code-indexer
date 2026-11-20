import type { DocHybridSearch } from '@mcp/services/services/docs/search.js';
import { applyThreshold, DEFAULT_MIN_RELEVANCE } from '@mcp/services/services/docs/relevance-policy.js';
import { labelRanked, successAtK, recallAtK, ndcgAtK, mrr, mean, type RelevantSpec } from '@mcp/services/services/docs/eval-metrics.js';

export type Mode = 'fts' | 'hybrid' | 'rerank';
export interface GoldQuery {
  query: string;
  doc_type?: string;
  collection?: string;
  relevant: RelevantSpec[];
}

export function parseGold(text: string): GoldQuery[] {
  const rows: GoldQuery[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const q = JSON.parse(line) as GoldQuery;
      if (typeof q?.query !== 'string' || !q.query.trim() || !Array.isArray(q.relevant)
          || [q.collection, q.doc_type].some(s => s !== undefined && typeof s !== 'string')
          || !q.relevant.every(spec => spec && typeof spec === 'object'
            && [spec.heading_contains, spec.source_uri_contains].every(s => s === undefined || (typeof s === 'string' && s.trim()))
            && (spec.heading_contains || spec.source_uri_contains))) throw new Error('invalid query or relevance labels');
      rows.push(q);
    } catch (cause) {
      throw new Error(`Invalid documentation gold at line ${i + 1}`, { cause });
    }
  }
  return rows;
}

export async function runOne(search: Pick<DocHybridSearch, 'search'>, mode: Mode, q: GoldQuery) {
  const started = performance.now();
  const { results, diag } = await search.search({
    query: q.query, collection: q.collection, limit: 10, min_relevance: DEFAULT_MIN_RELEVANCE,
    ...(mode === 'fts' ? { mode: 'fts' as const } : {}),
    ...(mode === 'rerank' ? { enhancements: { rerank: true, top_k_for_rerank: 20 } } : {}),
  });
  const ranked = labelRanked(results, q.relevant);
  const n = q.relevant.length;
  const thresholds = mode === 'rerank' ? [DEFAULT_MIN_RELEVANCE, 0.55, 0.75].map(cutoff => {
    const { kept } = applyThreshold(results, cutoff);
    return { cutoff, recall5: n ? recallAtK(labelRanked(kept, q.relevant), 5, n) : null,
      correctAbsence: !n && !kept.length && !diag.vector_collections?.failed.length };
  }) : undefined;
  return {
    query: q.query, mode, executed: diag.mode, doc_type: q.doc_type ?? '(untyped)', positive: n > 0,
    reranked: diag.rerank_used === true, skipReason: diag.rerank_skip_reason, candidates: diag.rerank_candidates ?? 0,
    vectorCollections: diag.vector_collections, elapsedMs: performance.now() - started, thresholds,
    correctAbsence: n === 0 && results.length === 0 && !diag.vector_collections?.failed.length,
    success5: successAtK(ranked, 5), recall5: recallAtK(ranked, 5, n), ndcg10: ndcgAtK(ranked, 10, n), rr: mrr(ranked),
  };
}

export type QueryScore = Awaited<ReturnType<typeof runOne>>;
export function aggregate(rows: QueryScore[]) {
  const positives = rows.filter(row => row.positive);
  const negatives = rows.filter(row => !row.positive);
  return {
    recall5: mean(positives.map(row => row.recall5)), success5: mean(positives.map(row => row.success5)),
    ndcg10: mean(positives.map(row => row.ndcg10)), mrr: mean(positives.map(row => row.rr)), n: positives.length,
    negatives: negatives.length, correctAbsences: negatives.filter(row => row.correctAbsence).length,
    reranked: rows.filter(row => row.reranked).length,
    thresholds: rows.some(row => row.thresholds) ? [DEFAULT_MIN_RELEVANCE, 0.55, 0.75].map(cutoff => {
      const scores = rows.flatMap(row => row.thresholds?.filter(score => score.cutoff === cutoff) ?? []);
      return { cutoff, recall5: mean(scores.flatMap(score => score.recall5 == null ? [] : [score.recall5])),
        correctAbsences: scores.filter(score => score.correctAbsence).length, negatives: negatives.length };
    }) : undefined,
  };
}
