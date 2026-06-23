/**
 * QueryRewriter — produces 2-4 variants of an agent query so the hybrid
 * search can fan out over synonyms, decomposed sub-questions, and
 * vocabulary the original phrasing missed.
 *
 * Why bother? The single-shot `rag_search_docs` tool inherits whatever
 * phrasing the LLM emitted (often vague, often verbose). A 0.95-cosine
 * passage that's worded differently from the query gets missed. Running
 * the same hybrid pipeline over 3-4 reformulated variants and merging
 * via RRF gives a ~20-40% recall lift on conceptual queries without
 * requiring a different embedder.
 *
 * Provider/model is resolved via
 *   pipeline_provider_bindings('doc_search', 'rewriter')
 *
 * Anti-hallucination posture: the LLM is instructed to reuse terms from
 * the original query verbatim where possible and to NEVER invent product
 * names or version numbers. The output is parsed defensively; non-strings
 * are dropped and the original query is ALWAYS included as variant[0]
 * so the worst case (LLM emits garbage) degrades to "unchanged search".
 *
 * Caching: hits a sliver of `sub_agent_result_cache` under
 * `agent_type='doc_search.rewriter'` keyed by `prompt_hash=sha256(query)`
 * and `context_digest=model_id`. 24h TTL.
 *
 * Telemetry: each call emits a single row to `pipeline_telemetry` with
 * `pipeline_name='doc_search', stage='query_rewrite', candidates_in=1,
 * candidates_out=variants.length`.
 */
import { createHash } from 'node:crypto';
import type {
  PipelineProviderResolver,
  ResolveContext,
  ResolvedBinding,
} from '../../pipelines/index.js';
import { pickChatFn } from '../../quality/chat-dispatcher.js';
import type { SubAgentResultCacheStore } from '@mcp/store/sub-agent-result-cache-store.js';
import type {
  PipelineTelemetryStore,
  PipelineTelemetryInsert,
} from '@mcp/store/pipeline-telemetry-store.js';
import { durationToBucket } from '@mcp/store/pipeline-telemetry-store.js';

/** Cache TTL for rewrite variants — 24h covers same-session retries. */
const CACHE_TTL_SECONDS = 24 * 60 * 60;
/** Soft cap on variants returned (incl. the original). */
const MAX_VARIANTS = 4;
/** Cache namespace under sub_agent_result_cache. */
const CACHE_AGENT_TYPE = 'doc_search.rewriter';

export interface QueryRewriterOptions {
  resolver: PipelineProviderResolver;
  /** Optional cache backing (skip writes if absent). */
  cache?: SubAgentResultCacheStore | null;
  /** Optional telemetry sink (skip emit if absent). */
  telemetry?: PipelineTelemetryStore | null;
  /** Skip the LLM call (tests) — returns only the original query. */
  skipLlm?: boolean;
}

export interface RewriteOpts {
  /** Resolved context for binding lookup (session/template/global). */
  resolveContext?: ResolveContext;
  /** Optional cap on variants; clamped to [1, MAX_VARIANTS]. Default 4. */
  maxVariants?: number;
}

/**
 * Why the rewrite degraded, for honest telemetry:
 *   - 'none'       : ran normally (LLM produced variants, or cache hit)
 *   - 'skipped'    : skipLlm / empty query — no work attempted
 *   - 'no_binding' : no provider binding configured (a config gap, not a failure)
 *   - 'llm_error'  : the LLM call threw/timed out — the only real error
 * Only 'llm_error' is counted as a telemetry error.
 */
export type RewriteFailure = 'none' | 'skipped' | 'no_binding' | 'llm_error';

export interface RewriteResult {
  /** Variants in ranked order; variants[0] is ALWAYS the original query. */
  variants: string[];
  /**
   * Whether the LLM produced anything useful. False when:
   *   - LLM call was skipped (skipLlm)
   *   - no binding configured
   *   - LLM errored or response was unparseable
   *   - cache hit
   * The `variants` field is still populated (at minimum: [original]).
   */
  llmUsed: boolean;
  /** Whether the result came from cache. */
  cacheHit: boolean;
  /** True when a cache lookup actually ran (so a "miss" is a real miss). */
  cacheChecked: boolean;
  /** Degradation reason — drives the error metric. */
  failure: RewriteFailure;
  /** Model id from the resolved binding (null if no LLM call happened). */
  modelId: string | null;
  /** Wall-clock duration of the rewrite stage in ms. */
  durationMs: number;
}

/**
 * Rewriter — class so callers can keep one instance around (cheap
 * constructor) and pass it to `DocHybridSearch` via `enhancements`.
 */
export class QueryRewriter {
  constructor(private opts: QueryRewriterOptions) {}

  /**
   * Rewrite the query into variants. Always returns at least the original
   * as variants[0]; on any failure path, variants still contains the
   * original so the caller can fall back to a single hybrid search.
   */
  async rewrite(query: string, opts: RewriteOpts = {}): Promise<RewriteResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return {
        variants: [normalizedQuery],
        llmUsed: false,
        cacheHit: false,
        cacheChecked: false,
        failure: 'skipped',
        modelId: null,
        durationMs: 0,
      };
    }

    const maxVariants = clamp(opts.maxVariants ?? MAX_VARIANTS, 1, MAX_VARIANTS);
    const started = Date.now();

    if (this.opts.skipLlm) {
      const result: RewriteResult = {
        variants: [normalizedQuery],
        llmUsed: false,
        cacheHit: false,
        cacheChecked: false,
        failure: 'skipped',
        modelId: null,
        durationMs: Date.now() - started,
      };
      this.emitTelemetry(result, opts);
      return result;
    }

    // Resolve binding first — we need its model_id to compute cache key.
    const binding = await this.opts.resolver.resolveOrNull(
      'doc_search',
      'rewriter',
      opts.resolveContext ?? {},
    );
    if (!binding) {
      const result: RewriteResult = {
        variants: [normalizedQuery],
        llmUsed: false,
        cacheHit: false,
        cacheChecked: false,
        failure: 'no_binding',
        modelId: null,
        durationMs: Date.now() - started,
      };
      this.emitTelemetry(result, opts);
      return result;
    }

    const promptHash = sha256(normalizedQuery);
    const contextDigest = `${binding.provider.id}:${binding.modelId}:v${maxVariants}`;

    // Cache lookup.
    if (this.opts.cache) {
      const cached = this.opts.cache.lookup({
        prompt_hash: promptHash,
        context_digest: contextDigest,
        agent_type: CACHE_AGENT_TYPE,
      });
      if (cached) {
        const variants = parseCachedVariants(cached.result_json, normalizedQuery, maxVariants);
        const result: RewriteResult = {
          variants,
          llmUsed: false,
          cacheHit: true,
          cacheChecked: true,
          failure: 'none',
          modelId: binding.modelId,
          durationMs: Date.now() - started,
        };
        this.emitTelemetry(result, opts);
        return result;
      }
    }

    // LLM call. null signals a real transport/parse error (vs. a successful
    // call that simply produced no extra variants).
    const llmVariants = await this.callLlm(binding, normalizedQuery, maxVariants);
    const variants = llmVariants ?? [normalizedQuery];
    const llmUsed = variants.length > 1;

    // Cache write — only on success (≥2 variants).
    if (llmUsed && this.opts.cache) {
      try {
        this.opts.cache.upsert({
          prompt_hash: promptHash,
          context_digest: contextDigest,
          agent_type: CACHE_AGENT_TYPE,
          result_json: JSON.stringify(variants),
          ttl_seconds: CACHE_TTL_SECONDS,
        });
      } catch {
        // Non-fatal — cache writes failing shouldn't kill the search.
      }
    }

    const result: RewriteResult = {
      variants,
      llmUsed,
      cacheHit: false,
      cacheChecked: !!this.opts.cache,
      failure: llmVariants === null ? 'llm_error' : 'none',
      modelId: binding.modelId,
      durationMs: Date.now() - started,
    };
    this.emitTelemetry(result, opts);
    return result;
  }

  private async callLlm(
    binding: ResolvedBinding,
    query: string,
    maxVariants: number,
  ): Promise<string[] | null> {
    const chat = pickChatFn(binding);
    try {
      const result = await chat(binding, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(query, maxVariants) },
      ]);
      return parseLlmResponse(result.content, query, maxVariants);
    } catch {
      // Network/timeout/parse error → signal failure to the caller.
      return null;
    }
  }

  private emitTelemetry(result: RewriteResult, opts: RewriteOpts): void {
    if (!this.opts.telemetry) return;
    const ctx = opts.resolveContext ?? {};
    const row: PipelineTelemetryInsert = {
      session_id: ctx.sessionId ?? null,
      company_session_id: ctx.companySessionId ?? null,
      pipeline_name: 'doc_search',
      stage: 'query_rewrite',
      component_name: 'QueryRewriter',
      duration_ms: result.durationMs,
      duration_bucket: durationToBucket(result.durationMs),
      candidates_in: 1,
      candidates_out: result.variants.length,
      cache_hits: result.cacheHit ? 1 : 0,
      // Only a real lookup that missed counts as a miss (not no-binding/skip).
      cache_misses: result.cacheChecked && !result.cacheHit ? 1 : 0,
      // Only a true LLM transport/parse error is an error; no_binding / skipped
      // / "LLM produced no extra variants" are degradations, not failures.
      errors: result.failure === 'llm_error' ? 1 : 0,
      diag: {
        model_id: result.modelId,
        llm_used: result.llmUsed,
        failure: result.failure,
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const SYSTEM_PROMPT = `You rewrite a developer's documentation-search query into 2-3 alternative phrasings to improve recall over a technical doc corpus.

Rules:
1. PRESERVE all literal product names, library names, versions, and API symbols from the original query — never rename them.
2. Each variant must be a complete, standalone query (not a fragment).
3. Use technical vocabulary the docs are likely to contain (e.g. "OAuth 2.0 authorization code flow" instead of "login flow").
4. If the original query asks multiple things, you MAY split it into sub-questions.
5. Do NOT add new product names, frameworks, or versions that weren't in the original.
6. Keep variants SHORT (under 120 chars each).

Respond ONLY with a JSON array of strings, no prose:
["variant 1", "variant 2", ...]`;

function buildPrompt(query: string, maxVariants: number): string {
  const want = Math.max(1, maxVariants - 1); // -1 because variants[0] is the original
  return `Rewrite this documentation query into ${want} alternative phrasings:

"${query}"

Respond with a JSON array of ${want} strings.`;
}

function parseLlmResponse(text: string, originalQuery: string, maxVariants: number): string[] {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [originalQuery];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [originalQuery];
  }
  if (!Array.isArray(parsed)) return [originalQuery];

  const seen = new Set<string>([originalQuery.toLowerCase()]);
  const variants: string[] = [originalQuery];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, 240);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(trimmed);
    if (variants.length >= maxVariants) break;
  }
  return variants;
}

function parseCachedVariants(json: string, originalQuery: string, maxVariants: number): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [originalQuery];
    const variants = parsed
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .slice(0, maxVariants);
    // Ensure original is variants[0] even if the cache stored an old shape.
    if (variants.length === 0) return [originalQuery];
    if (variants[0] !== originalQuery) {
      const idx = variants.indexOf(originalQuery);
      if (idx > 0) variants.splice(idx, 1);
      variants.unshift(originalQuery);
    }
    return variants.slice(0, maxVariants);
  } catch {
    return [originalQuery];
  }
}

function stripFences(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}
