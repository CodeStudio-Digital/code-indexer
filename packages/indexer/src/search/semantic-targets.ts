/**
 * Runtime targets for the distributed semantic index.
 *
 * Vector persistence is deliberately absent from this module: every target
 * only turns text into vectors (or reranks candidates). The store/router owns
 * the local sqlite-vec files, so selecting a cloud model can never silently
 * move vector storage out of the workstation.
 */
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type {
  EmbeddingTarget,
  RerankerTarget,
  SemanticPurpose,
} from '@mcp/store/semantic-store.js';
import {
  BedrockTitanEmbeddingService,
  NullEmbeddingService,
  OpenAICompatEmbeddingService,
  type EmbeddingService,
} from './embeddings.js';
import { LocalEmbeddingService } from './local-embeddings.js';
import {
  CloudflareWorkersAIReranker,
  CohereReranker,
  NullReranker,
  OpenAICompatibleReranker,
  type RerankerService,
} from './reranker.js';
import { LocalReranker } from './local-reranker.js';
import { BedrockReranker } from './bedrock-reranker.js';
import type {
  RerankCandidate,
  RerankRequestOptions,
  RerankResult,
} from './reranker-types.js';
import { resolveLocalReranker } from './local-reranker-policy.js';

export type { EmbeddingTarget, RerankerTarget, SemanticPurpose } from '@mcp/store/semantic-store.js';

const OPENAI_BASES: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  zai: 'https://api.z.ai/api/paas/v4',
};

function assertLoopback(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('local_http endpoint must resolve to localhost/127.0.0.1/::1');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('local_http endpoint must use http or https');
  }
  return raw.replace(/\/+$/, '');
}

function resolveProviderBaseURL(provider: {
  kind: string;
  base_url: string | null;
  extra: Record<string, unknown>;
}): string {
  if (provider.kind === 'cloudflare') {
    const accountId = cloudflareAccountId(provider);
    const configured = provider.base_url?.trim();
    if (configured && !configured.includes('{account_id}')) return configured.replace(/\/+$/, '');
    return (configured || 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1')
      .replaceAll('{account_id}', accountId)
      .replace(/\/+$/, '');
  }
  if (provider.base_url) return provider.base_url.replace(/\/+$/, '');
  const base = OPENAI_BASES[provider.kind];
  if (!base) throw new Error(`Provider ${provider.kind} has no semantic HTTP adapter`);
  return base;
}

function cloudflareAccountId(provider: { extra: Record<string, unknown> }): string {
  const accountId = String(
    provider.extra.account_id
      ?? process.env.CLOUDFLARE_ACCOUNT_ID
      ?? process.env.CF_ACCOUNT_ID
      ?? '',
  ).trim();
  if (!accountId) {
    throw new Error('Cloudflare provider requires extra.account_id or CLOUDFLARE_ACCOUNT_ID');
  }
  return accountId;
}

function unit(vector: number[]): number[] {
  if (vector.length === 0) throw new Error('embedding returned an empty vector');
  let norm2 = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('embedding returned a non-finite value');
    norm2 += value * value;
  }
  if (norm2 <= 0) throw new Error('embedding returned a zero vector');
  const norm = Math.sqrt(norm2);
  return vector.map((value) => value / norm);
}

/** Enforces the invariant sqlite-vec relies on: one finite unit-length space. */
export class NormalizedEmbeddingService implements EmbeddingService {
  private dimension: number | null = null;

  constructor(private readonly inner: EmbeddingService) {}

  private validate(vectors: number[][], expected: number): number[][] {
    if (vectors.length !== expected) {
      throw new Error(`embedding returned ${vectors.length} vector(s) for ${expected} input(s)`);
    }
    const normalized = vectors.map(unit);
    for (const vector of normalized) {
      if (this.dimension === null) this.dimension = vector.length;
      else if (vector.length !== this.dimension) {
        throw new Error(`embedding dimension changed from ${this.dimension} to ${vector.length}`);
      }
    }
    return normalized;
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
    if (texts.length === 0) return { vectors: [], tokens: 0 };
    const result = await this.inner.embed(texts);
    return { ...result, vectors: this.validate(result.vectors, texts.length) };
  }

  async embedQuery(text: string): Promise<{ vector: number[]; tokens: number }> {
    const result = await this.inner.embedQuery(text);
    return { ...result, vector: this.validate([result.vector], 1)[0] };
  }

  fingerprint(): string {
    return `${this.inner.fingerprint?.() ?? this.inner.constructor.name}:unit-v1`;
  }

  maxConcurrency(): number {
    return this.inner.maxConcurrency?.() ?? 1;
  }

  async dispose(): Promise<void> {
    await this.inner.dispose?.();
  }

  diagnostics(): { dimension: number | null; inner?: unknown } {
    const diagnostic = this.inner as { diagnostics?: () => unknown };
    return { dimension: this.dimension, inner: diagnostic.diagnostics?.() };
  }
}

function bedrockCredentials(store: ProviderStore, id: string): {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
} {
  const provider = store.getProvider(id);
  const token = store.getOAuth(id);
  const extra = token?.extra ?? {};
  return {
    region: String(
      extra.region
        ?? provider?.extra.aws_region
        ?? process.env.AWS_REGION
        ?? process.env.AWS_DEFAULT_REGION
        ?? 'us-east-1',
    ),
    accessKeyId: typeof extra.accessKeyId === 'string' ? extra.accessKeyId : undefined,
    secretAccessKey: typeof extra.secretAccessKey === 'string' ? extra.secretAccessKey : undefined,
    sessionToken: typeof extra.sessionToken === 'string' ? extra.sessionToken : undefined,
  };
}

export function createEmbeddingServiceForTarget(
  target: EmbeddingTarget,
  store: ProviderStore,
): EmbeddingService {
  if (target.kind === 'disabled') return new NullEmbeddingService();

  let service: EmbeddingService;
  if (target.kind === 'onnx') {
    service = new LocalEmbeddingService({
      model: target.model,
      revision: target.revision,
      cacheDir: target.cacheDir,
      dtype: target.dtype ?? 'q8',
      protocol: {
        pooling: target.pooling,
        normalize: target.normalize,
        queryTemplate: target.queryTemplate,
        documentTemplate: target.documentTemplate,
        maxTokens: target.maxTokens,
      },
    });
  } else if (target.kind === 'local_http') {
    const endpoint = assertLoopback(target.baseUrl);
    service = new OpenAICompatEmbeddingService({
      baseURL: endpoint,
      apiKey: undefined,
      model: target.model,
      providerId: 'local-http',
    });
  } else {
    const id = target.providerId;
    const provider = store.getProvider(id);
    if (!provider || !provider.enabled) throw new Error(`Semantic provider ${id || '<empty>'} is unavailable`);
    if (provider.kind === 'bedrock' || target.protocol === 'bedrock') {
      const credentials = bedrockCredentials(store, id);
      service = new BedrockTitanEmbeddingService({
        region: credentials.region ?? 'us-east-1',
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        modelId: target.model,
      });
    } else {
      if (!provider.api_key) throw new Error(`Provider ${id} has no API key`);
      service = new OpenAICompatEmbeddingService({
        baseURL: resolveProviderBaseURL(provider),
        apiKey: provider.api_key,
        model: target.model,
        providerId: id,
      });
    }
  }
  return new NormalizedEmbeddingService(service);
}

export function createRerankerForTarget(
  target: RerankerTarget,
  store: ProviderStore,
  options: { strict?: boolean } = {},
): RerankerService {
  if (target.kind === 'disabled') return new NullReranker();
  let service: RerankerService;
  if (target.kind === 'onnx') {
    const resolved = resolveLocalReranker(target);
    if (!resolved.enabled || !resolved.model) {
      const reason = resolved.downgradeReason ?? 'local reranker unavailable';
      service = {
        name: 'local-unavailable',
        rerank: async () => { throw new Error(reason); },
        diagnostics: () => resolved,
      };
    } else {
      service = new LocalReranker({
        model: resolved.model,
        revision: target.revision,
        cacheDir: target.cacheDir,
        dtype: resolved.dtype,
        maxTokens: target.maxTokens,
        executionProvider: resolved.executionProvider,
        strict: options.strict,
      });
    }
  } else if (target.kind === 'local_http') {
    const endpoint = assertLoopback(target.baseUrl);
    service = target.protocol === 'openai-rerank'
      ? new OpenAICompatibleReranker({
          endpoint: `${endpoint}/rerank`,
          model: target.model,
          name: 'local-http',
          strict: options.strict,
        })
      : new CohereReranker({
          endpoint: `${endpoint}/rerank`,
          apiKey: '',
          model: target.model,
          name: 'local-http',
          strict: options.strict,
        });
  } else {
    const id = target.providerId;
    const provider = store.getProvider(id);
    if (!provider || !provider.enabled) throw new Error(`Semantic provider ${id || '<empty>'} is unavailable`);
    if (provider.kind === 'bedrock' || target.protocol === 'bedrock') {
      const credentials = bedrockCredentials(store, id);
      service = new BedrockReranker({
        model: target.model,
        region: credentials.region,
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        strict: options.strict,
      });
    } else {
      if (!provider.api_key) throw new Error(`Provider ${id} has no API key`);
      if (provider.kind === 'cloudflare' || target.protocol === 'cloudflare') {
        const accountId = cloudflareAccountId(provider);
        service = new CloudflareWorkersAIReranker({
          accountId,
          apiToken: provider.api_key,
          model: target.model,
          strict: options.strict,
        });
      } else {
        service = target.protocol === 'openai-rerank'
          ? new OpenAICompatibleReranker({
              endpoint: `${resolveProviderBaseURL(provider)}/rerank`,
              apiKey: provider.api_key,
              model: target.model,
              name: `provider:${id}`,
              strict: options.strict,
            })
          : new CohereReranker({
              endpoint: `${resolveProviderBaseURL(provider)}/rerank`,
              apiKey: provider.api_key,
              model: target.model,
              name: `provider:${id}`,
              strict: options.strict,
            });
      }
    }
  }
  return options.strict ? new StrictReranker(service) : new FailOpenReranker(service);
}

function validateRerankResults(
  inner: RerankerService,
  candidates: RerankCandidate[],
  results: RerankResult[],
  topK: number,
): RerankResult[] {
  const expected = Math.min(Math.max(0, topK), candidates.length);
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const resultIds = new Set(results.map((result) => result.id));
  if (
    results.length !== expected
    || resultIds.size !== results.length
    || results.some((result) => !candidateIds.has(result.id) || !Number.isFinite(result.score))
  ) {
    throw new Error(`${inner.name} reranker returned an invalid result set`);
  }
  return [...results].sort((a, b) => b.score - a.score).slice(0, topK);
}

/** Strict target facade used by calibrated consumers. Concrete adapters
 * surface transport/inference failures and this layer additionally rejects
 * incomplete or malformed result sets instead of assigning implicit scores. */
class StrictReranker implements RerankerService {
  constructor(private readonly inner: RerankerService) {}
  get name(): string { return this.inner.name; }
  cacheRevision(): string {
    return this.inner.cacheRevision?.() ?? `legacy:${this.inner.name}`;
  }
  diagnostics(): unknown | Promise<unknown> {
    return this.inner.diagnostics?.() ?? null;
  }
  candidatePoolSize(topK: number): number {
    return this.inner.candidatePoolSize?.(topK) ?? Math.max(topK, topK * 2);
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK = 10,
    options?: RerankRequestOptions,
  ): Promise<RerankResult[]> {
    const results = await this.inner.rerank(query, candidates, topK, options);
    return validateRerankResults(this.inner, candidates, results, topK);
  }

  async dispose(): Promise<void> {
    await (this.inner as { dispose?: () => Promise<void> }).dispose?.();
  }
}

/** Fail-open consumers preserve the incoming RRF order if any reranker
 * (including a local ONNX session) fails. Calibrated consumers and probes use
 * the strict facade above so a broken target is observable. */
class FailOpenReranker implements RerankerService {
  constructor(private readonly inner: RerankerService) {}
  get name(): string { return this.inner.name; }
  cacheRevision(): string {
    return this.inner.cacheRevision?.() ?? `legacy:${this.inner.name}`;
  }
  diagnostics(): unknown | Promise<unknown> {
    return this.inner.diagnostics?.() ?? null;
  }
  candidatePoolSize(topK: number): number {
    return this.inner.candidatePoolSize?.(topK) ?? Math.max(topK, topK * 2);
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK = 10,
    options?: RerankRequestOptions,
  ): Promise<RerankResult[]> {
    const fallback = (): RerankResult[] => candidates
      .map((candidate) => ({
        id: candidate.id,
        score: candidate.originalScore,
        originalScore: candidate.originalScore,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    try {
      const results = await this.inner.rerank(query, candidates, topK, options);
      return validateRerankResults(this.inner, candidates, results, topK);
    } catch (error) {
      console.warn(`[semantic] ${this.inner.name} reranker unavailable; preserving RRF order: ${
        error instanceof Error ? error.message : String(error)
      }`);
      return fallback();
    }
  }

  async dispose(): Promise<void> {
    await (this.inner as { dispose?: () => Promise<void> }).dispose?.();
  }
}

export interface EmbeddingProbeResult {
  ok: true;
  dimension: number;
  fingerprint: string;
  latency_ms: number;
}

export async function probeEmbeddingTarget(
  target: EmbeddingTarget,
  store: ProviderStore,
): Promise<EmbeddingProbeResult> {
  if (target.kind === 'disabled') throw new Error('Disabled target cannot be probed');
  const service = createEmbeddingServiceForTarget(target, store);
  const started = Date.now();
  try {
    const docs = await service.embed(['semantic probe document', 'different retrieval passage']);
    const query = await service.embedQuery('semantic probe query');
    const dimension = docs.vectors[0]?.length ?? 0;
    if (!dimension || docs.vectors.some((v) => v.length !== dimension) || query.vector.length !== dimension) {
      throw new Error('embedding probe returned inconsistent dimensions');
    }
    return {
      ok: true,
      dimension,
      fingerprint: service.fingerprint?.() ?? 'embedding:unknown',
      latency_ms: Date.now() - started,
    };
  } finally {
    await service.dispose?.();
  }
}

export async function probeRerankerTarget(
  target: RerankerTarget,
  store: ProviderStore,
): Promise<{ ok: true; latency_ms: number; model: string }> {
  if (target.kind === 'disabled') return { ok: true, latency_ms: 0, model: 'disabled' };
  const service = createRerankerForTarget(target, store, { strict: true });
  const started = Date.now();
  try {
    const results = await service.rerank('cache implementation', [
      { id: 'relevant', text: 'The cache stores values and evicts least recently used entries.', originalScore: 0.1 },
      { id: 'unrelated', text: 'This function paints a blue button.', originalScore: 0.2 },
    ], 2);
    const ids = new Set(results.map((result) => result.id));
    if (
      results.length !== 2
      || ids.size !== 2
      || !ids.has('relevant')
      || !ids.has('unrelated')
      || results.some((r) => !Number.isFinite(r.score))
    ) {
      throw new Error('reranker probe returned an invalid result');
    }
    const model = target.kind === 'onnx'
      ? (resolveLocalReranker(target).model ?? 'rrf')
      : target.model;
    return { ok: true, latency_ms: Date.now() - started, model };
  } finally {
    await (service as { dispose?: () => Promise<void> }).dispose?.();
  }
}
