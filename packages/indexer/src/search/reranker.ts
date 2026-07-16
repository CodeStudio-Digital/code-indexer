/**
 * Cross-encoder re-ranking service.
 *
 * After the RRF merge of FTS + vector results, re-ranks the top-N candidates
 * using a cross-encoder that sees (query, document) pairs together. This
 * dramatically improves precision over independent scoring.
 *
 * Supports:
 *   - Local cross-encoder (transformers.js ONNX, offline — see ./local-reranker.ts)
 *   - Cloudflare Workers AI (@cf/baai/bge-reranker-v2-m3)
 *   - Cohere Rerank API (rerank-v3.5)
 *   - Null (passthrough, for when no reranker is configured)
 */

import type { RerankCandidate, RerankResult, RerankerService } from './reranker-types.js';

// Re-export the contract types so existing importers (`@mcp/indexer/search/reranker.js`)
// keep working after the extraction to ./reranker-types.ts (avoids an import cycle
// with ./local-reranker.ts, which implements the interface).
export type {
  RerankCandidate,
  RerankRequestOptions,
  RerankResult,
  RerankerService,
} from './reranker-types.js';

function mapIndexedResults(options: {
  rows: Array<{ index?: number; score?: number }>;
  candidates: RerankCandidate[];
  topK: number;
  name: string;
  strict: boolean;
}): RerankResult[] {
  const { rows, candidates, topK, name, strict } = options;
  const expected = Math.min(Math.max(0, topK), candidates.length);
  const seen = new Set<number>();
  const invalid = rows.length !== expected || rows.some((row) => {
    const index = row.index;
    if (!Number.isInteger(index) || index! < 0 || index! >= candidates.length) return true;
    if (seen.has(index!)) return true;
    seen.add(index!);
    return !Number.isFinite(row.score);
  });
  if (invalid) {
    const message = `${name} rerank returned an incomplete or invalid result set`;
    if (strict) throw new Error(message);
    console.error(`[reranker] ${message}`);
    return candidates.slice(0, expected).map((candidate) => ({
      id: candidate.id,
      score: candidate.originalScore,
      originalScore: candidate.originalScore,
    }));
  }
  return rows.map((row) => {
    const candidate = candidates[row.index!];
    return { id: candidate.id, score: row.score!, originalScore: candidate.originalScore };
  });
}

// ─── Cloudflare Workers AI Reranker ──────────────────────────────

export class CloudflareReranker implements RerankerService {
  readonly name = 'cloudflare';
  private workerUrl: string;
  private workerToken: string;

  constructor(opts: { workerUrl: string; workerToken?: string }) {
    this.workerUrl = opts.workerUrl.replace(/\/$/, '');
    this.workerToken = opts.workerToken ?? '';
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.workerToken) headers['Authorization'] = `Bearer ${this.workerToken}`;

    const response = await fetch(`${this.workerUrl}/rerank`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        documents: candidates.map(c => c.text),
        top_k: topK,
      }),
    });

    if (!response.ok) {
      console.error(`[reranker] Cloudflare rerank failed: ${response.status}`);
      // Graceful fallback: return original order
      return candidates.slice(0, topK).map(c => ({
        id: c.id,
        score: c.originalScore,
        originalScore: c.originalScore,
      }));
    }

    const data = await response.json() as { results: Array<{ index: number; score: number }> };

    return data.results
      .slice(0, topK)
      .map(r => ({
        id: candidates[r.index].id,
        score: r.score,
        originalScore: candidates[r.index].originalScore,
      }));
  }
}

// ─── Cohere-compatible Reranker (Cohere, OpenRouter) ─────────────

/**
 * Cohere `/v2/rerank` client. The request/response shape
 * (`{ model, query, documents, top_n }` → `{ results: [{ index,
 * relevance_score }] }`) is shared by OpenRouter's `/api/v1/rerank`, so the
 * `endpoint` is parametrized: the `provider` reranker kind points it at a
 * configured provider's base URL + `/rerank` (see semantic-targets).
 */
export class CohereReranker implements RerankerService {
  readonly name: string;
  private apiKey: string;
  private model: string;
  private endpoint: string;
  private strict: boolean;

  constructor(opts: { apiKey: string; model?: string; endpoint?: string; name?: string; strict?: boolean }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'rerank-v3.5';
    this.endpoint = opts.endpoint ?? 'https://api.cohere.com/v2/rerank';
    this.name = opts.name ?? 'cohere';
    this.strict = opts.strict ?? false;
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        query,
        documents: candidates.map(c => c.text),
        top_n: topK,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const message = `${this.name} rerank failed: ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`;
      if (this.strict) throw new Error(message);
      console.error(`[reranker] ${message}`);
      return candidates.slice(0, topK).map(c => ({
        id: c.id,
        score: c.originalScore,
        originalScore: c.originalScore,
      }));
    }

    const data = await response.json() as { results?: Array<{ index?: number; relevance_score?: number }> };
    if (!Array.isArray(data.results)) {
      if (this.strict) throw new Error(`${this.name} rerank returned no results array`);
      return candidates.slice(0, topK).map(c => ({
        id: c.id,
        score: c.originalScore,
        originalScore: c.originalScore,
      }));
    }

    return mapIndexedResults({
      rows: data.results.map((row) => ({ index: row.index, score: row.relevance_score })),
      candidates,
      topK,
      name: this.name,
      strict: this.strict,
    });
  }
}

// ─── OpenAI-compatible Reranker ─────────────────────────────────

/**
 * Small compatibility adapter for local/provider `/rerank` endpoints that use
 * Bearer auth and expose scores as either `data[].score` or
 * `results[].score`. The request deliberately follows the de-facto rerank
 * shape (`model`, `query`, `documents`, `top_n`) used alongside OpenAI-style
 * APIs; Cohere's stricter `relevance_score` response remains handled by
 * `CohereReranker` above.
 */
export class OpenAICompatibleReranker implements RerankerService {
  readonly name: string;

  constructor(private readonly options: {
    endpoint: string;
    apiKey?: string;
    model: string;
    name?: string;
    strict?: boolean;
  }) {
    this.name = options.name ?? 'openai-compatible';
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const fallback = (): RerankResult[] => candidates.slice(0, topK).map((candidate) => ({
      id: candidate.id,
      score: candidate.originalScore,
      originalScore: candidate.originalScore,
    }));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.options.model,
        query,
        documents: candidates.map((candidate) => candidate.text),
        top_n: Math.min(topK, candidates.length),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const message = `${this.name} rerank failed: ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`;
      if (this.options.strict) throw new Error(message);
      console.error(`[reranker] ${message}`);
      return fallback();
    }
    const payload = await response.json() as {
      data?: Array<{ index?: number; score?: number; relevance_score?: number }>;
      results?: Array<{ index?: number; score?: number; relevance_score?: number }>;
      result?: Array<{ index?: number; score?: number; relevance_score?: number }>;
    };
    const rows = payload.data ?? payload.results ?? payload.result;
    if (!Array.isArray(rows)) {
      const message = `${this.name} rerank returned no result array`;
      if (this.options.strict) throw new Error(message);
      console.error(`[reranker] ${message}`);
      return fallback();
    }
    return mapIndexedResults({
      rows: rows.map((row) => ({
        index: row.index,
        score: row.score ?? row.relevance_score,
      })),
      candidates,
      topK,
      name: this.name,
      strict: this.options.strict ?? false,
    });
  }
}

/** Native Cloudflare Workers AI reranker adapter. Embeddings use the OpenAI
 * compatible `/ai/v1/embeddings` endpoint, while rerank models use `/ai/run`.
 */
export class CloudflareWorkersAIReranker implements RerankerService {
  readonly name = 'cloudflare';
  constructor(private readonly options: {
    accountId: string;
    apiToken: string;
    model: string;
    strict?: boolean;
  }) {}

  async rerank(query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const fallback = (): RerankResult[] => candidates.slice(0, topK).map((candidate) => ({
      id: candidate.id,
      score: candidate.originalScore,
      originalScore: candidate.originalScore,
    }));
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/ai/run/${this.options.model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          contexts: candidates.map((candidate) => ({ text: candidate.text })),
          top_k: Math.min(topK, candidates.length),
        }),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const message = `Cloudflare rerank failed: ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`;
      if (this.options.strict) throw new Error(message);
      console.error(`[reranker] ${message}`);
      return fallback();
    }
    const payload = await response.json() as {
      success?: boolean;
      result?: { response?: Array<{ id?: number; index?: number; score?: number }> };
      errors?: Array<{ message?: string }>;
    };
    const results = payload.result?.response;
    if (!payload.success || !Array.isArray(results)) {
      const message = payload.errors?.map((error) => error.message).filter(Boolean).join('; ')
        || 'Cloudflare rerank returned an invalid response';
      if (this.options.strict) throw new Error(message);
      console.error(`[reranker] ${message}`);
      return fallback();
    }
    return mapIndexedResults({
      rows: results.map((result) => ({
        index: result.id ?? result.index,
        score: result.score,
      })),
      candidates,
      topK,
      name: this.name,
      strict: this.options.strict ?? false,
    });
  }
}

// ─── Null Reranker (passthrough) ─────────────────────────────────

export class NullReranker implements RerankerService {
  readonly name = 'null';

  async rerank(_query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
    return candidates.slice(0, topK).map(c => ({
      id: c.id,
      score: c.originalScore,
      originalScore: c.originalScore,
    }));
  }
}
