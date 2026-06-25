/**
 * Parse benchmark config specs into concrete reranker/embedding instances,
 * reusing the same credential resolution as production (`provider` kinds pull
 * an already-configured chat provider's key + base URL via
 * `resolveProviderEndpoint`).
 *
 * Spec grammar (colon-separated; model may itself contain colons, e.g.
 * `…:free`, so everything after the id is the model):
 *   reranker:  null | local[:model] | default | provider:<id>[:model]
 *   embedding: live | local[:model] | provider:<id>:<model>
 */
import type { ProviderStore } from '@mcp/store/provider-store.js';
import {
  createReranker,
  NullReranker,
  CohereReranker,
  type RerankerService,
} from '@mcp/indexer/search/reranker.js';
import { LocalReranker } from '@mcp/indexer/search/local-reranker.js';
import {
  createEmbeddingService,
  OpenAICompatEmbeddingService,
  type EmbeddingService,
} from '@mcp/indexer/search/embeddings.js';
import { LocalEmbeddingService } from '@mcp/indexer/search/local-embeddings.js';
import { resolveProviderEndpoint } from '@mcp/indexer/search/provider-endpoints.js';

const DEFAULT_RERANK_MODEL = 'nvidia/llama-nemotron-rerank-vl-1b-v2:free';

interface ParsedSpec {
  kind: string;
  id?: string;
  model?: string;
}

function parseSpec(spec: string): ParsedSpec {
  const parts = spec.split(':');
  const kind = parts[0];
  if (kind === 'provider') {
    return { kind, id: parts[1], model: parts.slice(2).join(':') || undefined };
  }
  return { kind, model: parts.slice(1).join(':') || undefined };
}

export function buildReranker(
  spec: string,
  store: ProviderStore,
): { label: string; reranker: RerankerService } {
  const { kind, id, model } = parseSpec(spec);
  switch (kind) {
    case 'null':
      return { label: 'null', reranker: new NullReranker() };
    case 'local':
      return { label: spec, reranker: new LocalReranker({ model }) };
    case 'default':
    case 'store':
      return { label: 'default', reranker: createReranker(store) };
    case 'provider': {
      const ep = resolveProviderEndpoint(store.getProvider(id ?? ''));
      if (!ep) throw new Error(`benchmark: reranker provider '${id}' has no API key or isn't OpenAI-compatible`);
      return {
        label: spec,
        reranker: new CohereReranker({
          apiKey: ep.apiKey,
          model: model || DEFAULT_RERANK_MODEL,
          endpoint: `${ep.baseURL}/rerank`,
          name: `provider:${id}`,
        }),
      };
    }
    default:
      throw new Error(`benchmark: unknown reranker spec '${spec}'`);
  }
}

/**
 * `needsScratch` = the vectors for this embedding aren't in the live index, so
 * the caller must re-embed the corpus into a scratch vector store before use
 * (the embedding-comparison flow). `live`/`default` reuse the existing index.
 */
export function buildEmbedding(
  spec: string,
  store: ProviderStore,
): { label: string; service: EmbeddingService; needsScratch: boolean } {
  const { kind, id, model } = parseSpec(spec);
  switch (kind) {
    case 'live':
    case 'default':
    case 'store':
      return { label: 'live', service: createEmbeddingService(store), needsScratch: false };
    case 'local':
      return { label: spec, service: new LocalEmbeddingService({ model }), needsScratch: true };
    case 'provider': {
      const ep = resolveProviderEndpoint(store.getProvider(id ?? ''));
      if (!ep) throw new Error(`benchmark: embedding provider '${id}' has no API key or isn't OpenAI-compatible`);
      if (!model) throw new Error(`benchmark: embedding 'provider:${id}' needs a model — use provider:${id}:<model>`);
      return {
        label: spec,
        service: new OpenAICompatEmbeddingService({ baseURL: ep.baseURL, apiKey: ep.apiKey, model, providerId: id }),
        needsScratch: true,
      };
    }
    default:
      throw new Error(`benchmark: unknown embedding spec '${spec}'`);
  }
}
