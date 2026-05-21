/**
 * Reranker — re-orders the top-K candidates returned by the hybrid search
 * (FTS5 + Vector via RRF) using an LLM that scores each (query, chunk)
 * pair on relevance to the original query.
 *
 * Why bother? RRF assumes equal-quality rankings between FTS and vector
 * — but a 0.95 cosine and a 0.95 BM25 don't carry the same meaning.
 * Re-ranking the top-20 with a single LLM pass gives finer-grained
 * relevance signal at modest cost. The reranker also helps when the
 * query is conceptual and the matching passage uses different wording
 * than any single embedding could capture.
 *
 * Provider/model is resolved via
 *   pipeline_provider_bindings('doc_search', 'reranker')
 *
 * Default LLM-as-reranker: scores each chunk individually 0-1 in a
 * single batched call. A cross-encoder (bge-reranker-v2-m3) can be
 * swapped in via the admin panel — same binding role, different
 * provider kind. This MVP only implements the LLM path; cross-encoder
 * support is a fast follow.
 *
 * Caching: persists verdicts in `doc_rerank_cache` keyed by
 *   (sha256(query), sha256(sorted chunk_ids), model_id)
 * 24h TTL via the `idx_doc_rerank_cache_created` index purge.
 *
 * Telemetry: one row per call to `pipeline_telemetry` with
 *   pipeline_name='doc_search', stage='rerank'
 *   candidates_in=N (incoming top-K), candidates_out=N (kept ranks)
 *   diag={ dropped: number, cache_hit: bool, model_id }
 *
 * Degradation: missing binding, LLM error, or unparseable response →
 * return candidates unchanged (the caller still gets a search result;
 * just no rerank lift).
 */
import { createHash } from 'node:crypto';
import type DatabaseConstructor from 'better-sqlite3';
import type {
  PipelineProviderResolver,
  ResolveContext,
  ResolvedBinding,
} from '../../pipelines/index.js';
import { pickChatFn } from '../../quality/chat-dispatcher.js';
import type {
  PipelineTelemetryStore,
  PipelineTelemetryInsert,
} from '@mcp/store/pipeline-telemetry-store.js';
import { durationToBucket } from '@mcp/store/pipeline-telemetry-store.js';

type DB = InstanceType<typeof DatabaseConstructor>;

/** Maximum chars from a chunk snippet sent to the LLM (cost control). */
const SNIPPET_MAX_CHARS = 600;
/** TTL pruning happens lazily — clients should run pruneOlderThan on boot. */

export interface RerankCandidate {
  chunk_id: number;
  heading_path: string | null;
  snippet: string;
  /** Original score (pre-rerank) — preserved on the output. */
  pre_rerank_score: number;
  /** Optional concepts/tags — included if available, helps the LLM. */
  concepts?: string[];
}

export interface RerankResult<TCandidate extends RerankCandidate = RerankCandidate> {
  /** Candidates in new order. Items may be dropped if score below cutoff. */
  candidates: TCandidate[];
  /** Whether the reranker ran (false on degraded paths). */
  reranked: boolean;
  /** Whether the rerank verdict came from cache. */
  cacheHit: boolean;
  /** Number of candidates dropped vs input length. */
  dropped: number;
  /** Model id used (null on degraded path). */
  modelId: string | null;
  /** Wall-clock duration of the rerank stage in ms. */
  durationMs: number;
}

export interface RerankerOptions {
  resolver: PipelineProviderResolver;
  /** SQLite handle for the `doc_rerank_cache` table (migration 098). */
  db?: DB | null;
  /** Optional telemetry sink. */
  telemetry?: PipelineTelemetryStore | null;
  /** Skip the LLM call (tests) — returns candidates unchanged with reranked=false. */
  skipLlm?: boolean;
}

export interface RerankOpts {
  resolveContext?: ResolveContext;
  /** Override the score cutoff (0-1). Default 0 (keep everything). */
  scoreCutoff?: number;
}

export class Reranker {
  constructor(private opts: RerankerOptions) {}

  async rerank<TCandidate extends RerankCandidate>(
    query: string,
    candidates: TCandidate[],
    opts: RerankOpts = {},
  ): Promise<RerankResult<TCandidate>> {
    const started = Date.now();
    const normalizedQuery = query.trim();

    if (!normalizedQuery || candidates.length <= 1 || this.opts.skipLlm) {
      const result: RerankResult<TCandidate> = {
        candidates,
        reranked: false,
        cacheHit: false,
        dropped: 0,
        modelId: null,
        durationMs: Date.now() - started,
      };
      this.emitTelemetry(result, candidates.length, opts);
      return result;
    }

    const binding = await this.opts.resolver.resolveOrNull(
      'doc_search',
      'reranker',
      opts.resolveContext ?? {},
    );
    if (!binding) {
      const result: RerankResult<TCandidate> = {
        candidates,
        reranked: false,
        cacheHit: false,
        dropped: 0,
        modelId: null,
        durationMs: Date.now() - started,
      };
      this.emitTelemetry(result, candidates.length, opts);
      return result;
    }

    // Cache lookup.
    const queryHash = sha256(normalizedQuery);
    const candidatesHash = sha256(
      candidates
        .map((c) => c.chunk_id)
        .slice()
        .sort((a, b) => a - b)
        .join(','),
    );
    const modelId = `${binding.provider.id}:${binding.modelId}`;
    const cached = this.lookupCache(queryHash, candidatesHash, modelId);
    if (cached) {
      const reordered = applyCachedOrder(candidates, cached, opts.scoreCutoff ?? 0);
      const result: RerankResult<TCandidate> = {
        candidates: reordered,
        reranked: true,
        cacheHit: true,
        dropped: candidates.length - reordered.length,
        modelId: binding.modelId,
        durationMs: Date.now() - started,
      };
      this.emitTelemetry(result, candidates.length, opts);
      return result;
    }

    // LLM call.
    const scores = await this.callLlm(binding, normalizedQuery, candidates);
    if (!scores) {
      const result: RerankResult<TCandidate> = {
        candidates,
        reranked: false,
        cacheHit: false,
        dropped: 0,
        modelId: binding.modelId,
        durationMs: Date.now() - started,
      };
      this.emitTelemetry(result, candidates.length, opts);
      return result;
    }

    // Apply scores → reorder + cutoff.
    const scored = candidates.map((c, i) => ({
      candidate: c,
      score: scores[i] ?? 0,
    }));
    scored.sort((a, b) => b.score - a.score);
    const cutoff = opts.scoreCutoff ?? 0;
    const kept = scored.filter((s) => s.score >= cutoff).map((s) => s.candidate);

    // Cache write.
    const cachePayload = scored.map((s) => ({
      chunk_id: s.candidate.chunk_id,
      score: round3(s.score),
    }));
    this.upsertCache(queryHash, candidatesHash, modelId, cachePayload);

    const result: RerankResult<TCandidate> = {
      candidates: kept,
      reranked: true,
      cacheHit: false,
      dropped: candidates.length - kept.length,
      modelId: binding.modelId,
      durationMs: Date.now() - started,
    };
    this.emitTelemetry(result, candidates.length, opts);
    return result;
  }

  // ─── Cache (doc_rerank_cache, migration 098) ───────────────────────

  private lookupCache(
    queryHash: string,
    candidatesHash: string,
    modelId: string,
  ): Array<{ chunk_id: number; score: number }> | null {
    const db = this.opts.db;
    if (!db) return null;
    try {
      const row = db
        .prepare(
          `SELECT reranked_order_json FROM doc_rerank_cache
            WHERE query_hash = ? AND candidates_hash = ? AND model_id = ?
              AND julianday('now') - julianday(created_at) < 1.0`, // 24h TTL
        )
        .get(queryHash, candidatesHash, modelId) as { reranked_order_json: string } | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.reranked_order_json);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .filter((p): p is { chunk_id: number; score: number } =>
          p != null &&
          typeof p === 'object' &&
          typeof (p as { chunk_id?: unknown }).chunk_id === 'number' &&
          typeof (p as { score?: unknown }).score === 'number',
        );
    } catch {
      return null;
    }
  }

  private upsertCache(
    queryHash: string,
    candidatesHash: string,
    modelId: string,
    payload: Array<{ chunk_id: number; score: number }>,
  ): void {
    const db = this.opts.db;
    if (!db) return;
    try {
      db.prepare(
        `INSERT INTO doc_rerank_cache (query_hash, candidates_hash, model_id, reranked_order_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(query_hash, candidates_hash, model_id) DO UPDATE SET
           reranked_order_json = excluded.reranked_order_json,
           created_at          = datetime('now')`,
      ).run(queryHash, candidatesHash, modelId, JSON.stringify(payload));
    } catch {
      // Cache writes are best-effort.
    }
  }

  /** Prune cache entries older than 24h. Call from boot sweep. */
  static pruneStaleCache(db: DB, olderThanHours: number = 24): number {
    try {
      const result = db
        .prepare(
          `DELETE FROM doc_rerank_cache
            WHERE julianday('now') - julianday(created_at) > ?`,
        )
        .run(olderThanHours / 24);
      return Number(result.changes);
    } catch {
      return 0;
    }
  }

  // ─── LLM ─────────────────────────────────────────────────────────

  private async callLlm(
    binding: ResolvedBinding,
    query: string,
    candidates: RerankCandidate[],
  ): Promise<number[] | null> {
    const chat = pickChatFn(binding);
    try {
      const result = await chat(binding, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(query, candidates) },
      ]);
      return parseLlmResponse(result.content, candidates.length);
    } catch {
      return null;
    }
  }

  // ─── Telemetry ───────────────────────────────────────────────────

  private emitTelemetry(
    result: RerankResult<RerankCandidate>,
    candidatesIn: number,
    opts: RerankOpts,
  ): void {
    if (!this.opts.telemetry) return;
    const ctx = opts.resolveContext ?? {};
    const row: PipelineTelemetryInsert = {
      session_id: ctx.sessionId ?? null,
      company_session_id: ctx.companySessionId ?? null,
      pipeline_name: 'doc_search',
      stage: 'rerank',
      component_name: 'Reranker',
      duration_ms: result.durationMs,
      duration_bucket: durationToBucket(result.durationMs),
      candidates_in: candidatesIn,
      candidates_out: result.candidates.length,
      cache_hits: result.cacheHit ? 1 : 0,
      cache_misses: result.reranked && !result.cacheHit ? 1 : 0,
      errors: !result.reranked && candidatesIn > 1 ? 1 : 0,
      diag: {
        model_id: result.modelId,
        dropped: result.dropped,
        reranked: result.reranked,
      },
    };
    try {
      this.opts.telemetry.insert(row);
    } catch {
      // Telemetry must never block the hot path.
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function applyCachedOrder<T extends RerankCandidate>(
  candidates: T[],
  cached: Array<{ chunk_id: number; score: number }>,
  scoreCutoff: number,
): T[] {
  const byId = new Map(candidates.map((c) => [c.chunk_id, c]));
  const out: T[] = [];
  for (const entry of cached) {
    if (entry.score < scoreCutoff) continue;
    const c = byId.get(entry.chunk_id);
    if (c) out.push(c);
  }
  // Append any candidate the cache didn't see (defensive — shouldn't happen
  // because the cache key is over the sorted id set, but keeps invariants
  // simple if the schema drifts).
  if (out.length < candidates.length) {
    const present = new Set(out.map((c) => c.chunk_id));
    for (const c of candidates) {
      if (!present.has(c.chunk_id)) out.push(c);
    }
  }
  return out;
}

const SYSTEM_PROMPT = `You score documentation passages for relevance to a developer's query.

For each passage you receive, output a relevance score from 0.0 (irrelevant) to 1.0 (highly relevant, directly answers the query).

Scoring guide:
- 1.0: passage is a direct, authoritative answer
- 0.8: passage covers the topic with a useful example or definition
- 0.5: passage mentions the topic but doesn't answer the query
- 0.2: passage shares vocabulary but is off-topic (e.g. blog mention)
- 0.0: completely unrelated (different product, different problem)

Respond ONLY with a JSON array of N floats (one per input), in the same order, no prose:
[0.92, 0.45, 0.78, ...]`;

function buildPrompt(query: string, candidates: RerankCandidate[]): string {
  const blocks = candidates.map((c, i) => {
    const head = `### Passage ${i + 1}\nHeading: ${c.heading_path ?? '(untitled)'}`;
    const conceptsLine = c.concepts && c.concepts.length > 0
      ? `\nConcepts: ${c.concepts.join(', ')}`
      : '';
    const body = c.snippet.length > SNIPPET_MAX_CHARS
      ? c.snippet.slice(0, SNIPPET_MAX_CHARS) + '…'
      : c.snippet;
    return `${head}${conceptsLine}\n---\n${body}\n`;
  });
  return `Query: "${query}"\n\nScore the following ${candidates.length} passages for relevance:\n\n${blocks.join('\n')}\n\nRespond with a JSON array of ${candidates.length} floats.`;
}

function parseLlmResponse(text: string, expectedLength: number): number[] | null {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // Coerce to numbers; clamp to [0, 1]; pad with 0 if short, truncate if long.
  const scores: number[] = [];
  for (let i = 0; i < expectedLength; i++) {
    const raw = parsed[i];
    let n: number;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string') n = Number(raw);
    else if (raw != null && typeof raw === 'object' && 'score' in raw) {
      const inner = (raw as { score?: unknown }).score;
      n = typeof inner === 'number' ? inner : 0;
    } else {
      n = 0;
    }
    if (!Number.isFinite(n)) n = 0;
    scores.push(Math.max(0, Math.min(1, n)));
  }
  return scores;
}

function stripFences(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}
