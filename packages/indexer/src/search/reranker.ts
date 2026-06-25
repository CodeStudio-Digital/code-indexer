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

import { LocalReranker } from './local-reranker.js';
import { resolveProviderEndpoint } from './provider-endpoints.js';
import type { RerankCandidate, RerankResult, RerankerService } from './reranker-types.js';

// Re-export the contract types so existing importers (`@mcp/indexer/search/reranker.js`)
// keep working after the extraction to ./reranker-types.ts (avoids an import cycle
// with ./local-reranker.ts, which implements the interface).
export type { RerankCandidate, RerankResult, RerankerService } from './reranker-types.js';

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
 * configured provider's base URL + `/rerank` (see `createReranker`).
 */
export class CohereReranker implements RerankerService {
  readonly name: string;
  private apiKey: string;
  private model: string;
  private endpoint: string;

  constructor(opts: { apiKey: string; model?: string; endpoint?: string; name?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'rerank-v3.5';
    this.endpoint = opts.endpoint ?? 'https://api.cohere.com/v2/rerank';
    this.name = opts.name ?? 'cohere';
  }

  async rerank(query: string, candidates: RerankCandidate[], topK = 10): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents: candidates.map(c => c.text),
        top_n: topK,
      }),
    });

    if (!response.ok) {
      console.error(`[reranker] ${this.name} rerank failed: ${response.status}`);
      return candidates.slice(0, topK).map(c => ({
        id: c.id,
        score: c.originalScore,
        originalScore: c.originalScore,
      }));
    }

    const data = await response.json() as { results: Array<{ index: number; relevance_score: number }> };

    return data.results
      .slice(0, topK)
      .map(r => ({
        id: candidates[r.index].id,
        score: r.relevance_score,
        originalScore: candidates[r.index].originalScore,
      }));
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

// ─── Factory ─────────────────────────────────────────────────────

/**
 * Minimal structural view of the admin ProviderStore. Declared locally so
 * this module stays decoupled from `@mcp/store` (the indexer is imported in
 * contexts — tests, the worker — that don't construct a ProviderStore).
 */
interface RerankerConfigSource {
  getDefaultReranker(): {
    kind: string;
    config: Record<string, unknown>;
  } | null;
  /**
   * Resolve a configured chat provider's credentials. Used by the `provider`
   * reranker kind to reuse an existing provider's key + base URL instead of
   * storing a duplicate one. Optional so callers (CLI/tests) without a full
   * ProviderStore still satisfy the type.
   */
  getProvider?(id: string): { kind: string; base_url: string | null; api_key: string | null } | null;
}

/**
 * Build a RerankerService.
 *
 * Priority:
 *   1. The admin-managed default in `reranker_configs` (via ProviderStore).
 *   2. Legacy env vars (COHERE_API_KEY / MCP_RERANK_WORKER_URL) — covers
 *      callers that pass no store (CLI/tests before seeding).
 *   3. NullReranker — RRF ordering only (the prior behavior).
 *
 * `seedFromEnvIfEmpty()` migrates the env vars into `reranker_configs` at
 * boot, so case 1 covers env-configured installs after the first run.
 */
export function createReranker(store?: RerankerConfigSource | null): RerankerService {
  const cfg = store?.getDefaultReranker?.() ?? null;
  if (cfg) {
    if (cfg.kind === 'local') {
      const c = cfg.config as { model?: string; cacheDir?: string };
      return new LocalReranker({ model: c.model, cacheDir: c.cacheDir });
    }
    if (cfg.kind === 'cohere') {
      const c = cfg.config as { apiKey?: string; model?: string };
      if (c.apiKey) return new CohereReranker({ apiKey: c.apiKey, model: c.model });
    }
    if (cfg.kind === 'cloudflare') {
      const c = cfg.config as { workerUrl?: string; workerToken?: string };
      if (c.workerUrl) return new CloudflareReranker({ workerUrl: c.workerUrl, workerToken: c.workerToken });
    }
    // Reuse a configured chat provider's credentials. OpenRouter exposes a
    // Cohere-shaped `/rerank`; the model defaults to the free Nemotron reranker.
    if (cfg.kind === 'provider') {
      const c = cfg.config as { providerId?: string; model?: string };
      const ep = resolveProviderEndpoint(store?.getProvider?.(c.providerId ?? ''));
      if (ep) {
        return new CohereReranker({
          apiKey: ep.apiKey,
          model: c.model || 'nvidia/llama-nemotron-rerank-vl-1b-v2:free',
          endpoint: `${ep.baseURL}/rerank`,
          name: 'provider',
        });
      }
    }
  }

  const cohereKey = process.env.COHERE_API_KEY;
  if (cohereKey) {
    return new CohereReranker({ apiKey: cohereKey, model: process.env.COHERE_RERANK_MODEL });
  }

  const cfUrl = process.env.MCP_RERANK_WORKER_URL;
  if (cfUrl) {
    return new CloudflareReranker({
      workerUrl: cfUrl,
      workerToken: process.env.MCP_RERANK_WORKER_TOKEN,
    });
  }

  return new NullReranker();
}
