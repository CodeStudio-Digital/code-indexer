import type { ProviderStore } from '@mcp/store/provider-store.js';
import type {
  EmbeddingTarget,
  RerankerTarget,
  SemanticPurpose,
  SemanticStore,
} from '@mcp/store/semantic-store.js';
import {
  generationMatchesEmbeddingFingerprint,
  type VectorWriteTarget,
} from '@mcp/store/vectors.js';
import type { EmbeddingService } from './embeddings.js';
import type {
  RerankCandidate,
  RerankRequestOptions,
  RerankResult,
  RerankerService,
} from './reranker.js';
import {
  createEmbeddingServiceForTarget,
  createRerankerForTarget,
} from './semantic-targets.js';
import {
  semanticEmbeddingFingerprint,
  semanticTargetContextFingerprint,
} from './semantic-fingerprint.js';

export type EmbeddingDecorator = (
  target: EmbeddingTarget,
  /** Lazy fallback factory: ONNX hosts can return a worker proxy without even
   * constructing an in-process local adapter. */
  createFallback: () => EmbeddingService,
) => EmbeddingService;

export type RerankerDecorator = (
  target: RerankerTarget,
  /** Lazy fallback factory so an HTTP/Electron host can route ONNX to its
   * worker without even constructing an in-process local adapter. */
  createFallback: () => RerankerService,
) => RerankerService;

export interface SemanticRerankerOptions {
  /**
   * Surface target/inference failures to the caller. Documentation search
   * uses this so its adapter can mark the result set as uncalibrated instead
   * of mistaking fail-open RRF scores for cross-encoder relevance.
   */
  strict?: boolean;
}

function key(target: EmbeddingTarget | RerankerTarget, providers: ProviderStore): string {
  return semanticTargetContextFingerprint(target, providers);
}

/** Live semantic runtime. Desired-profile edits affect new builds without a
 * restart, while query proxies stay pinned to each namespace's active
 * generation. Equal targets share the same cached ONNX session/worker. */
export class SemanticProfileRuntime {
  private readonly embeddings = new Map<string, EmbeddingService>();
  private readonly rerankers = new Map<string, RerankerService>();
  private readonly embeddingProxies = new Map<SemanticPurpose, EmbeddingService>();
  private readonly queryEmbeddingProxies = new Map<SemanticPurpose, EmbeddingService>();
  private readonly rerankerProxies = new Map<string, RerankerService>();

  constructor(
    private readonly semanticStore: Pick<SemanticStore, 'getProfile' | 'getActiveGeneration'>
      & Partial<Pick<SemanticStore, 'getWriteGeneration' | 'requiresExplicitNamespaceReindex'>>,
    private readonly providerStore: ProviderStore,
    private readonly decorateEmbedding?: EmbeddingDecorator,
    private readonly decorateReranker?: RerankerDecorator,
  ) {}

  embedding(purpose: SemanticPurpose): EmbeddingService {
    const cached = this.embeddingProxies.get(purpose);
    if (cached) return cached;
    const resolve = (): EmbeddingService => this.resolveEmbedding(purpose);
    const proxy: EmbeddingService & { diagnostics?: () => unknown } = {
      embed: (texts) => resolve().embed(texts),
      embedDocumentsForNamespace: (namespace, texts) =>
        this.embedWriteDocuments(purpose, namespace, texts),
      embedQuery: (text) => resolve().embedQuery(text),
      fingerprint: () => this.desiredEmbeddingFingerprint(purpose),
      maxConcurrency: () => resolve().maxConcurrency?.() ?? 1,
      diagnostics: () => {
        const service = resolve() as { diagnostics?: () => unknown };
        return service.diagnostics?.() ?? null;
      },
    };
    this.embeddingProxies.set(purpose, proxy);
    return proxy;
  }

  /**
   * Namespace-aware query proxy. Unlike `embedding()`, this never reads the
   * desired profile target: each query resolves the snapshot persisted on the
   * namespace's active generation. Missing active coverage throws so callers
   * can degrade to FTS instead of silently mixing vector spaces.
   */
  queryEmbedding(purpose: SemanticPurpose): EmbeddingService {
    const cached = this.queryEmbeddingProxies.get(purpose);
    if (cached) return cached;
    const namespaceRequired = (): never => {
      throw new Error(`${purpose} semantic query requires an active namespace generation`);
    };
    const proxy: EmbeddingService = {
      embed: async () => namespaceRequired(),
      embedQuery: async () => namespaceRequired(),
      embedQueryForNamespace: (namespace, text) =>
        this.embedActiveQuery(purpose, namespace, text),
      cacheRevisionForNamespace: (namespace) =>
        this.activeQueryCacheRevision(purpose, namespace),
      queryBlockReasonForNamespace: (namespace) =>
        this.activeQueryBlockReason(purpose, namespace),
      fingerprint: () => `semantic:${purpose}:active-generation`,
      maxConcurrency: () => 1,
    };
    this.queryEmbeddingProxies.set(purpose, proxy);
    return proxy;
  }

  reranker(purpose: SemanticPurpose, options: SemanticRerankerOptions = {}): RerankerService {
    const strict = options.strict === true;
    const proxyKey = `${purpose}:${strict ? 'strict' : 'fail-open'}`;
    const cached = this.rerankerProxies.get(proxyKey);
    if (cached) return cached;
    const resolve = (): RerankerService => this.resolveReranker(purpose);
    const proxy: RerankerService = {
      get name() { return resolve().name; },
      cacheRevision: () => {
        const target = this.currentRerankerTarget(purpose);
        // Strictness changes failure handling, not successful ranking
        // semantics. Keep the revision identical for the same target so
        // result caches are invalidated only by model/provider changes.
        return `semantic:${purpose}:reranker:${key(target, this.providerStore)}`;
      },
      diagnostics: () => resolve().diagnostics?.() ?? null,
      candidatePoolSize: (topK) =>
        resolve().candidatePoolSize?.(topK) ?? Math.max(topK, topK * 2),
      rerank: async (
        query: string,
        candidates: RerankCandidate[],
        topK = 10,
        rerankOptions?: RerankRequestOptions,
      ): Promise<RerankResult[]> => {
        const service = resolve();
        if (strict) return service.rerank(query, candidates, topK, rerankOptions);
        try {
          return await service.rerank(query, candidates, topK, rerankOptions);
        } catch (error) {
          console.warn(`[semantic] ${service.name} reranker unavailable; preserving RRF order: ${
            error instanceof Error ? error.message : String(error)
          }`);
          return candidates
            .map((candidate) => ({
              id: candidate.id,
              score: candidate.originalScore,
              originalScore: candidate.originalScore,
            }))
            .sort((left, right) => right.score - left.score)
            .slice(0, topK);
        }
      },
    };
    this.rerankerProxies.set(proxyKey, proxy);
    return proxy;
  }

  currentEmbeddingTarget(purpose: SemanticPurpose): EmbeddingTarget {
    const profile = this.semanticStore.getProfile(purpose);
    if (!profile) throw new Error(`Missing semantic profile: ${purpose}`);
    return profile.embedding_target;
  }

  currentRerankerTarget(purpose: SemanticPurpose): RerankerTarget {
    const profile = this.semanticStore.getProfile(purpose);
    if (!profile) throw new Error(`Missing semantic profile: ${purpose}`);
    return profile.reranker_target;
  }

  /** Read the resolved worker policy/model without forcing an ONNX session
   * load. Worker-backed services return an async snapshot; remote adapters may
   * legitimately expose no diagnostics. */
  async rerankerDiagnostics(purpose: SemanticPurpose): Promise<unknown> {
    const service = this.resolveReranker(purpose);
    return await service.diagnostics?.() ?? null;
  }

  async probeEmbeddingTarget(target: EmbeddingTarget): Promise<{
    ok: true;
    dimension: number;
    fingerprint: string;
    latency_ms: number;
  }> {
    if (target.kind === 'disabled') throw new Error('Disabled target cannot be probed');
    const service = this.resolveEmbeddingTarget(target);
    const started = Date.now();
    const docs = await service.embed(['semantic probe document', 'different retrieval passage']);
    const query = await service.embedQuery('semantic probe query');
    const dimension = docs.vectors[0]?.length ?? 0;
    if (!dimension
      || docs.vectors.length !== 2
      || docs.vectors.some((vector) => vector.length !== dimension
        || vector.some((value) => !Number.isFinite(value)))
      || query.vector.length !== dimension
      || query.vector.some((value) => !Number.isFinite(value))) {
      throw new Error('embedding probe returned inconsistent or non-finite dimensions');
    }
    return {
      ok: true,
      dimension,
      fingerprint: service.fingerprint?.() ?? 'embedding:unknown',
      latency_ms: Date.now() - started,
    };
  }

  async probeRerankerTarget(target: RerankerTarget): Promise<{
    ok: true;
    latency_ms: number;
    model: string;
  }> {
    if (target.kind === 'disabled') return { ok: true, latency_ms: 0, model: 'disabled' };
    const service = this.resolveRerankerTarget(target);
    const started = Date.now();
    const results = await service.rerank('cache implementation', [
      { id: 'relevant', text: 'The cache stores values and evicts least recently used entries.', originalScore: 0.1 },
      { id: 'unrelated', text: 'This function paints a blue button.', originalScore: 0.2 },
    ], 2);
    if (results.length !== 2
      || new Set(results.map((result) => result.id)).size !== 2
      || results.some((result) => !Number.isFinite(result.score))) {
      throw new Error('reranker probe returned an invalid result');
    }
    const diagnostics = await service.diagnostics?.() as { resolved_model?: unknown } | undefined;
    return {
      ok: true,
      latency_ms: Date.now() - started,
      model: typeof diagnostics?.resolved_model === 'string'
        ? diagnostics.resolved_model
        : target.model,
    };
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.embeddings.values()].map((service) => service.dispose?.()));
    for (const service of this.rerankers.values()) {
      await (service as { dispose?: () => Promise<void> }).dispose?.();
    }
    this.embeddings.clear();
    this.rerankers.clear();
  }

  private resolveEmbedding(purpose: SemanticPurpose): EmbeddingService {
    const target = this.currentEmbeddingTarget(purpose);
    return this.resolveEmbeddingTarget(target);
  }

  private desiredEmbeddingFingerprint(purpose: SemanticPurpose): string {
    const target = this.currentEmbeddingTarget(purpose);
    if (target.kind === 'disabled') return 'null';
    return this.resolveEmbeddingSnapshot(target, purpose).fingerprint;
  }

  private resolveEmbeddingSnapshot(
    target: EmbeddingTarget,
    purpose: SemanticPurpose,
  ): { service: EmbeddingService; fingerprint: string } {
    const service = this.resolveEmbeddingTarget(target);
    const serviceFingerprint = service.fingerprint?.()
      ?? `semantic:${purpose}:unfingerprinted`;
    return {
      service,
      fingerprint: semanticEmbeddingFingerprint(target, this.providerStore, serviceFingerprint),
    };
  }

  private async embedActiveQuery(
    purpose: SemanticPurpose,
    namespace: string,
    text: string,
  ): Promise<{ vector: number[]; tokens: number; generationId: number }> {
    const blocked = this.activeQueryBlockReason(purpose, namespace);
    if (blocked) throw new Error(blocked);
    // Disabling a desired profile is an immediate serving decision. Keep the
    // old active generation for rollback/cleanup, but never continue querying
    // it after the operator selected the FTS-only mode.
    const desiredProfile = this.semanticStore.getProfile(purpose);
    if (desiredProfile?.embedding_target.kind === 'disabled') {
      throw new Error(`${purpose} semantic profile is disabled`);
    }
    const generation = this.semanticStore.getActiveGeneration(namespace);
    if (!generation) throw new Error(`No active semantic generation for ${namespace}`);
    if (generation.purpose !== purpose) {
      throw new Error(`Active generation for ${namespace} belongs to ${generation.purpose}, not ${purpose}`);
    }
    if (generation.embedding_target.kind === 'disabled') {
      throw new Error(`Active generation for ${namespace} has no embedding target`);
    }
    const snapshot = this.resolveEmbeddingSnapshot(generation.embedding_target, purpose);
    if (!generationMatchesEmbeddingFingerprint(generation.fingerprint, snapshot.fingerprint)) {
      throw new Error(
        `Active generation ${generation.id} backend context no longer matches its embedding service`,
      );
    }
    const result = await snapshot.service.embedQuery(text);
    if (result.vector.length !== generation.dimension) {
      throw new Error(
        `Active generation for ${namespace} expects ${generation.dimension} dimensions, got ${result.vector.length}`,
      );
    }
    return { ...result, generationId: generation.id };
  }

  private async embedWriteDocuments(
    purpose: SemanticPurpose,
    namespace: string,
    texts: string[],
  ): Promise<{ vectors: number[][]; tokens: number; writeTarget: VectorWriteTarget }> {
    const generation = this.semanticStore.getWriteGeneration?.(namespace);
    if (!generation) throw new Error(`No writable semantic generation for ${namespace}`);
    if (generation.purpose !== purpose) {
      throw new Error(`Writable generation for ${namespace} belongs to ${generation.purpose}, not ${purpose}`);
    }
    if (generation.embedding_target.kind === 'disabled') {
      throw new Error(`Writable generation for ${namespace} has no embedding target`);
    }

    // Resolve the concrete service once. A profile edit after this point may
    // create a new generation, but cannot change the model used by this batch.
    const snapshot = this.resolveEmbeddingSnapshot(generation.embedding_target, purpose);
    const { service, fingerprint: embeddingFingerprint } = snapshot;
    if (!generationMatchesEmbeddingFingerprint(generation.fingerprint, embeddingFingerprint)) {
      throw new Error(
        `Writable generation ${generation.id} fingerprint does not match its embedding service`,
      );
    }
    const result = await service.embed(texts);
    for (const vector of result.vectors) {
      if (vector.length !== generation.dimension) {
        throw new Error(
          `Writable generation for ${namespace} expects ${generation.dimension} dimensions, got ${vector.length}`,
        );
      }
    }
    return {
      ...result,
      writeTarget: {
        generationId: generation.id,
        generationFingerprint: generation.fingerprint,
        embeddingFingerprint,
        embeddingTarget: generation.embedding_target,
      },
    };
  }

  private activeQueryCacheRevision(purpose: SemanticPurpose, namespace: string): string {
    const blocked = this.activeQueryBlockReason(purpose, namespace);
    if (blocked) return `semantic:${purpose}:blocked:${namespace}:${blocked}`;
    const desiredProfile = this.semanticStore.getProfile(purpose);
    if (!desiredProfile) return `semantic:${purpose}:missing-profile`;
    if (desiredProfile.embedding_target.kind === 'disabled') {
      return `semantic:${purpose}:disabled`;
    }
    const generation = this.semanticStore.getActiveGeneration(namespace);
    if (!generation) return `semantic:${purpose}:no-active-generation`;
    if (generation.purpose !== purpose) {
      return `semantic:${purpose}:wrong-purpose:${generation.purpose}:g${generation.id}`;
    }
    try {
      const current = this.resolveEmbeddingSnapshot(generation.embedding_target, purpose).fingerprint;
      const state = generationMatchesEmbeddingFingerprint(generation.fingerprint, current)
        ? 'current'
        : 'backend-context-mismatch';
      return `semantic:${purpose}:g${generation.id}:${generation.fingerprint}:${generation.dimension}:${state}:${current}`;
    } catch {
      // Keep this synchronous cache hook fail-safe. The subsequent query will
      // surface the concrete provider error and the hybrid pipeline degrades
      // to FTS; this revision only prevents an old vector result cache hit.
      let context = 'unresolved';
      try {
        context = semanticTargetContextFingerprint(generation.embedding_target, this.providerStore);
      } catch { /* provider store itself is unavailable */ }
      return `semantic:${purpose}:g${generation.id}:backend-unavailable:${context}`;
    }
  }

  /** Evaluate cheap control-plane serving gates without resolving a target.
   * A wildcard stale marker must not instantiate an ONNX session merely
   * because an editor or agent issued a hybrid query. */
  private activeQueryBlockReason(purpose: SemanticPurpose, namespace: string): string | null {
    const desiredProfile = this.semanticStore.getProfile(purpose);
    if (!desiredProfile) return `Missing semantic profile: ${purpose}`;
    if (desiredProfile.embedding_target.kind === 'disabled') {
      return `${purpose} semantic profile is disabled`;
    }
    const generation = this.semanticStore.getActiveGeneration(namespace);
    if (!generation) return `No active semantic generation for ${namespace}`;
    if (generation.purpose !== purpose) {
      return `Active generation for ${namespace} belongs to ${generation.purpose}, not ${purpose}`;
    }
    if (generation.embedding_target.kind === 'disabled') {
      return `Active generation for ${namespace} has no embedding target`;
    }
    if (this.semanticStore.requiresExplicitNamespaceReindex?.(namespace)) {
      return `Semantic namespace ${namespace} is stale; explicit reindex required`;
    }
    return null;
  }

  private resolveEmbeddingTarget(target: EmbeddingTarget): EmbeddingService {
    const cacheKey = key(target, this.providerStore);
    let service = this.embeddings.get(cacheKey);
    if (!service) {
      const createFallback = () => createEmbeddingServiceForTarget(target, this.providerStore);
      service = this.decorateEmbedding?.(target, createFallback) ?? createFallback();
      this.embeddings.set(cacheKey, service);
    }
    return service;
  }

  private resolveReranker(purpose: SemanticPurpose): RerankerService {
    const target = this.currentRerankerTarget(purpose);
    return this.resolveRerankerTarget(target);
  }

  private resolveRerankerTarget(target: RerankerTarget): RerankerService {
    // The concrete adapter is always strict and cached only by the effective
    // target. Policy is applied by the lightweight purpose proxy above. This
    // lets Code, Docs and Memory share one ONNX session when
    // they select the same model instead of pinning two ~250 MB encoders.
    const cacheKey = key(target, this.providerStore);
    let service = this.rerankers.get(cacheKey);
    if (!service) {
      const createFallback = () =>
        createRerankerForTarget(target, this.providerStore, { strict: true });
      service = this.decorateReranker?.(target, createFallback) ?? createFallback();
      this.rerankers.set(cacheKey, service);
    }
    return service;
  }
}
