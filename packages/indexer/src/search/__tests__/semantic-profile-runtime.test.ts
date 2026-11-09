import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type {
  EmbeddingTarget,
  RerankerTarget,
  SemanticGenerationRow,
  SemanticProfileRow,
  SemanticPurpose,
} from '@mcp/store/semantic-store.js';
import { generationMatchesEmbeddingFingerprint } from '@mcp/store/vectors.js';
import { SemanticProfileRuntime } from '../semantic-profile-runtime.js';
import { semanticEmbeddingFingerprint } from '../semantic-fingerprint.js';
import type { EmbeddingService } from '../embeddings.js';

const NOW = '2026-07-15 12:00:00';
const EMPTY_PROVIDERS = {
  getProvider: () => null,
  getOAuth: () => null,
} as unknown as ProviderStore;

function profile(
  purpose: SemanticPurpose,
  embedding: EmbeddingTarget,
  reranker: RerankerTarget = { kind: 'onnx', model: 'Xenova/bge-reranker-base' },
): SemanticProfileRow {
  return {
    purpose,
    embedding_target: embedding,
    reranker_target: reranker,
    created_at: NOW,
    updated_at: NOW,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('SemanticProfileRuntime session cache', () => {
  it('keeps automatic code retrieval on the evaluated hybrid baseline while allowing explicit rerankers', async () => {
    let reranker: RerankerTarget = { kind: 'onnx', model: 'auto' };
    const runtime = new SemanticProfileRuntime({
      getProfile: purpose => profile(purpose, { kind: 'disabled' }, reranker),
      getActiveGeneration: () => null,
    }, EMPTY_PROVIDERS);
    const code = runtime.reranker('code');
    expect(code.queryBlockReason?.('Where is authentication checked?')).toBe('code_auto_reranker_not_promoted');
    expect(await code.rerank('Where is authentication checked?', [{ id: 'a', text: 'source', originalScore: .8 }], 1))
      .toEqual([{ id: 'a', score: .8, originalScore: .8 }]);
    expect(runtime.reranker('memory').queryBlockReason?.('Where is authentication checked?')).toBeNull();
    reranker = { kind: 'onnx', model: 'Xenova/bge-reranker-base' };
    expect(code.queryBlockReason?.('Where is authentication checked?')).toBeNull();
    await runtime.dispose();
  });
  it('coalesces equal query vectors across collections but revalidates generation and policy', async () => {
    const target: EmbeddingTarget = { kind: 'onnx', model: 'test', pooling: 'mean', normalize: true,
      queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}' };
    let active = true;
    let disabled = false;
    const embedQuery = vi.fn(async () => ({ vector: [1, 0], tokens: 10 }));
    const runtime = new SemanticProfileRuntime({
      getProfile: (purpose) => profile(purpose, disabled ? { kind: 'disabled' } : target),
      getActiveGeneration: () => active ? ({
        id: 1, purpose: 'docs', dimension: 2, embedding_target: target,
        fingerprint: semanticEmbeddingFingerprint(target, EMPTY_PROVIDERS, 'test'),
      } as SemanticGenerationRow) : null,
    }, EMPTY_PROVIDERS, () => ({ embed: vi.fn(), embedQuery, fingerprint: () => 'test' }));
    const service = runtime.queryEmbedding('docs');
    const [a, b] = await Promise.all([
      service.embedQueryForNamespace!('docs:c1', 'same'), service.embedQueryForNamespace!('docs:c2', 'same'),
    ]);
    expect(embedQuery).toHaveBeenCalledTimes(1);
    expect(a.vector).toEqual(b.vector);
    a.vector[0] = 9;
    expect((await service.embedQueryForNamespace!('docs:c2', 'same')).vector).toEqual([1, 0]);
    expect(embedQuery).toHaveBeenCalledTimes(1);
    active = false;
    await expect(service.embedQueryForNamespace!('docs:c2', 'same')).rejects.toThrow('No active');
    active = true; disabled = true;
    await expect(service.embedQueryForNamespace!('docs:c2', 'same')).rejects.toThrow('disabled');
  });
  it('lets an ONNX host choose a worker proxy without constructing the local fallback', () => {
    const target: EmbeddingTarget = {
      kind: 'onnx', model: 'worker/only', pooling: 'mean', normalize: true,
      queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}',
    };
    let fallbackConstructed = false;
    const runtime = new SemanticProfileRuntime(
      {
        getProfile: (purpose) => profile(purpose, target),
        getActiveGeneration: () => null,
      },
      EMPTY_PROVIDERS,
      (_target, _createFallback) => ({
        embed: async (texts) => ({ vectors: texts.map(() => [1]), tokens: 0 }),
        embedQuery: async () => ({ vector: [1], tokens: 0 }),
        fingerprint: () => 'worker-proxy',
      }),
    );
    // The only code that could construct the local adapter is the fallback
    // factory; the worker decorator deliberately never calls it.
    const createFallback = (runtime as unknown as { decorateEmbedding: (
      target: EmbeddingTarget,
      create: () => EmbeddingService,
    ) => EmbeddingService }).decorateEmbedding;
    createFallback(target, () => {
      fallbackConstructed = true;
      throw new Error('must stay in the worker');
    });

    expect(runtime.embedding('code').fingerprint?.()).toMatch(/^semantic-embedding:v2:/);
    expect(fallbackConstructed).toBe(false);
  });

  it('fingerprints complete ONNX and local HTTP target options', () => {
    const onnx: EmbeddingTarget = {
      kind: 'onnx',
      model: 'model/e5',
      revision: 'main',
      cacheDir: 'D:/models/a',
      pooling: 'mean',
      normalize: true,
      queryTemplate: 'query: {text}',
      documentTemplate: 'passage: {text}',
      maxTokens: 512,
    };
    const base = semanticEmbeddingFingerprint(onnx, EMPTY_PROVIDERS, 'local:model/e5:unit-v1');
    expect(generationMatchesEmbeddingFingerprint(
      `${base}:rebuild:1784102400000:a1b2c3`,
      base,
    )).toBe(true);
    expect(semanticEmbeddingFingerprint(
      { ...onnx, queryTemplate: 'search: {text}' },
      EMPTY_PROVIDERS,
      'local:model/e5:unit-v1',
    )).not.toBe(base);
    const localHttp: EmbeddingTarget = {
      kind: 'local_http',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'same-model',
      protocol: 'openai-embeddings',
    };
    expect(semanticEmbeddingFingerprint(localHttp, EMPTY_PROVIDERS, 'local-http:same-model'))
      .not.toBe(semanticEmbeddingFingerprint(
        { ...localHttp, baseUrl: 'http://127.0.0.1:1234/v1' },
        EMPTY_PROVIDERS,
        'local-http:same-model',
      ));
  });

  it('pins a document batch to its write generation while the profile changes', async () => {
    const targetA: EmbeddingTarget = {
      kind: 'onnx', model: 'space-a', pooling: 'mean', normalize: true,
      queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}',
    };
    const targetB: EmbeddingTarget = { ...targetA, model: 'space-b' };
    const generation = (
      id: number,
      target: EmbeddingTarget,
      fingerprint: string,
    ): SemanticGenerationRow => ({
      id,
      purpose: 'code',
      fingerprint,
      embedding_target: target,
      dimension: 2,
      status: 'building',
      expected_items: 1,
      indexed_items: 0,
      failed_items: 0,
      error: null,
      created_at: NOW,
      started_at: NOW,
      completed_at: null,
    });
    let desired = targetA;
    const fingerprintA = semanticEmbeddingFingerprint(targetA, EMPTY_PROVIDERS, 'space-a');
    const fingerprintB = semanticEmbeddingFingerprint(targetB, EMPTY_PROVIDERS, 'space-b');
    let writeGeneration = generation(11, targetA, fingerprintA);
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new SemanticProfileRuntime(
      {
        getProfile: (purpose) => profile(purpose, desired),
        getActiveGeneration: () => null,
        getWriteGeneration: () => writeGeneration,
      },
      EMPTY_PROVIDERS,
      (target) => {
        const model = target.kind === 'disabled' ? 'disabled' : target.model;
        return {
          embed: async (texts) => {
            if (model === 'space-a') {
              markStarted();
              await gate;
            }
            return {
              vectors: texts.map(() => model === 'space-a' ? [1, 0] : [0, 1]),
              tokens: texts.length,
            };
          },
          embedQuery: async () => ({ vector: model === 'space-a' ? [1, 0] : [0, 1], tokens: 1 }),
          fingerprint: () => model,
        };
      },
    );

    const inFlight = runtime.embedding('code').embedDocumentsForNamespace!('code:p7', ['old']);
    await started;
    desired = targetB;
    writeGeneration = generation(12, targetB, fingerprintB);
    release();

    const oldBatch = await inFlight;
    expect(oldBatch.vectors).toEqual([[1, 0]]);
    expect(oldBatch.writeTarget).toMatchObject({
      generationId: 11,
      generationFingerprint: fingerprintA,
      embeddingFingerprint: fingerprintA,
      embeddingTarget: targetA,
    });
    const newBatch = await runtime.embedding('code')
      .embedDocumentsForNamespace!('code:p7', ['new']);
    expect(newBatch.vectors).toEqual([[0, 1]]);
    expect(newBatch.writeTarget?.generationId).toBe(12);
    await runtime.dispose();
  });

  it('exposes synchronous query-generation and reranker cache revisions', async () => {
    const embeddingTarget: EmbeddingTarget = {
      kind: 'onnx', model: 'embedding/model', pooling: 'mean', normalize: true,
      queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}',
    };
    let activeId = 17;
    let currentProfile = profile('code', embeddingTarget);
    const runtime = new SemanticProfileRuntime(
      {
        getProfile: () => currentProfile,
        getActiveGeneration: () => ({
          id: activeId,
          purpose: 'code',
          fingerprint: `embedding:g${activeId}`,
          embedding_target: embeddingTarget,
          dimension: 384,
          status: 'ready',
          expected_items: 1,
          indexed_items: 1,
          failed_items: 0,
          error: null,
          created_at: NOW,
          started_at: NOW,
          completed_at: NOW,
        }),
      },
      EMPTY_PROVIDERS,
    );

    const queryProxy = runtime.queryEmbedding('code');
    const generation17 = queryProxy.cacheRevisionForNamespace!('code:p7');
    expect(queryProxy.cacheRevisionForNamespace!('code:p7')).toBe(generation17);
    activeId = 18;
    const generation18 = queryProxy.cacheRevisionForNamespace!('code:p7');
    expect(generation18).not.toBe(generation17);

    currentProfile = { ...currentProfile, embedding_target: { kind: 'disabled' } };
    const disabled = queryProxy.cacheRevisionForNamespace!('code:p7');
    expect(disabled).toContain('disabled');
    expect(disabled).not.toBe(generation18);

    const rerankerProxy = runtime.reranker('code');
    const rerankerA = rerankerProxy.cacheRevision!();
    expect(rerankerProxy.cacheRevision!()).toBe(rerankerA);
    currentProfile = {
      ...currentProfile,
      reranker_target: { kind: 'onnx', model: 'different/reranker' },
    };
    expect(rerankerProxy.cacheRevision!()).not.toBe(rerankerA);
    await runtime.dispose();
  });

  it('blocks stale wildcard queries before resolving or loading the embedding backend', async () => {
    const target: EmbeddingTarget = {
      kind: 'onnx', model: 'blocked/model', pooling: 'mean', normalize: true,
      queryTemplate: 'query: {text}', documentTemplate: 'passage: {text}',
    };
    const active: SemanticGenerationRow = {
      id: 17,
      purpose: 'code',
      fingerprint: semanticEmbeddingFingerprint(target, EMPTY_PROVIDERS, 'blocked/model'),
      embedding_target: target,
      dimension: 1,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
      created_at: NOW,
      started_at: NOW,
      completed_at: NOW,
    };
    let stale = true;
    const backendQuery = vi.fn(async () => ({ vector: [1], tokens: 1 }));
    const created = vi.fn(() => ({
      embed: async (texts: string[]) => ({ vectors: texts.map(() => [1]), tokens: 0 }),
      embedQuery: backendQuery,
      fingerprint: () => 'blocked/model',
    }));
    const runtime = new SemanticProfileRuntime(
      {
        getProfile: (purpose) => profile(purpose, target),
        getActiveGeneration: () => active,
        requiresExplicitNamespaceReindex: () => stale,
      },
      EMPTY_PROVIDERS,
      created,
    );
    const query = runtime.queryEmbedding('code');

    expect(query.queryBlockReasonForNamespace?.('code:p7')).toMatch(/explicit reindex required/);
    expect(query.cacheRevisionForNamespace?.('code:p7')).toContain('blocked');
    await expect(query.embedQueryForNamespace?.('code:p7', 'query'))
      .rejects.toThrow(/explicit reindex required/);
    expect(created).not.toHaveBeenCalled();
    expect(backendQuery).not.toHaveBeenCalled();

    stale = false;
    await expect(query.embedQueryForNamespace?.('code:p7', 'query')).resolves.toMatchObject({
      vector: [1], generationId: 17,
    });
    expect(backendQuery).toHaveBeenCalledOnce();
    await runtime.dispose();
  });

  it('shares equal ONNX targets across profiles regardless of JSON property order', async () => {
    const codeTarget: EmbeddingTarget = {
      kind: 'onnx',
      model: 'Xenova/multilingual-e5-small',
      pooling: 'mean',
      normalize: true,
      queryTemplate: 'query: {text}',
      documentTemplate: 'passage: {text}',
      maxTokens: 512,
    };
    const memoryTarget = {
      maxTokens: 512,
      documentTemplate: 'passage: {text}',
      queryTemplate: 'query: {text}',
      normalize: true,
      pooling: 'mean',
      model: 'Xenova/multilingual-e5-small',
      kind: 'onnx',
    } as EmbeddingTarget;
    const profiles = new Map<SemanticPurpose, SemanticProfileRow>([
      ['code', profile('code', codeTarget)],
      ['memory', profile('memory', memoryTarget)],
    ]);
    const created = vi.fn((_target, createFallback) => createFallback());
    const runtime = new SemanticProfileRuntime(
      {
        getProfile: (purpose) => profiles.get(purpose) ?? null,
        getActiveGeneration: () => null,
      },
      EMPTY_PROVIDERS,
      created,
    );

    runtime.embedding('code').fingerprint?.();
    runtime.embedding('memory').fingerprint?.();
    expect(created).toHaveBeenCalledTimes(1);

    expect(runtime.reranker('code').name).toBe('local');
    expect(runtime.reranker('memory').name).toBe('local');
    expect((runtime as unknown as { rerankers: Map<string, unknown> }).rerankers.size).toBe(1);
    await runtime.dispose();
  });

  it('shares one strict target service while applying strict/fail-open policy per proxy', async () => {
    const embeddingTarget: EmbeddingTarget = { kind: 'disabled' };
    const rerankerTarget: RerankerTarget = {
      kind: 'local_http',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'reranker/model',
      protocol: 'openai-rerank',
    };
    const runtime = new SemanticProfileRuntime(
      {
        getProfile: (purpose) => profile(purpose, embeddingTarget, rerankerTarget),
        getActiveGeneration: () => null,
      },
      EMPTY_PROVIDERS,
    );
    const failOpen = runtime.reranker('memory');
    const strict = runtime.reranker('memory', { strict: true });

    expect(strict).not.toBe(failOpen);
    expect(strict.cacheRevision!()).toBe(failOpen.cacheRevision!());
    expect(strict.name).toBe('local-http');
    expect(failOpen.name).toBe('local-http');
    expect((runtime as unknown as { rerankers: Map<string, unknown> }).rerankers.size).toBe(1);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('offline', { status: 503 })));
    const candidates = [
      { id: 'low', text: 'low', originalScore: 0.1 },
      { id: 'high', text: 'high', originalScore: 0.9 },
    ];
    await expect(strict.rerank('query', candidates, 2)).rejects.toThrow(/503/);
    await expect(failOpen.rerank('query', candidates, 2)).resolves.toEqual([
      { id: 'high', score: 0.9, originalScore: 0.9 },
      { id: 'low', score: 0.1, originalScore: 0.1 },
    ]);
    await runtime.dispose();
  });

  it('recreates provider services after credentials rotate', async () => {
    const target: EmbeddingTarget = {
      kind: 'provider', providerId: 'openai-main', model: 'text-embedding-3-small',
      protocol: 'openai-embeddings',
    };
    let provider = {
      id: 'openai-main', kind: 'openai', enabled: true,
      base_url: 'https://api.openai.com/v1', api_key: 'first-key', extra: {},
      updated_at: NOW,
    };
    const created = vi.fn((_target, service) => service);
    const runtime = new SemanticProfileRuntime(
      {
        getProfile: (purpose) => profile(purpose, target),
        getActiveGeneration: () => null,
      },
      {
        getProvider: () => provider,
        getOAuth: () => null,
      } as unknown as ProviderStore,
      created,
    );

    runtime.embedding('code').fingerprint?.();
    provider = { ...provider, api_key: 'rotated-key', updated_at: '2026-07-15 12:01:00' };
    runtime.embedding('code').fingerprint?.();
    expect(created).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  it('embeds queries with the active generation snapshot instead of the desired profile', async () => {
    const activeTarget: EmbeddingTarget = {
      kind: 'onnx', model: 'active/model', pooling: 'mean', normalize: true,
      queryTemplate: 'active-query: {text}', documentTemplate: 'active-doc: {text}',
    };
    const desiredTarget: EmbeddingTarget = {
      kind: 'onnx', model: 'desired/model', pooling: 'mean', normalize: true,
      queryTemplate: 'desired-query: {text}', documentTemplate: 'desired-doc: {text}',
    };
    let desired: EmbeddingTarget = desiredTarget;
    const active: SemanticGenerationRow = {
      id: 17,
      purpose: 'code',
      fingerprint: semanticEmbeddingFingerprint(activeTarget, EMPTY_PROVIDERS, 'active/model'),
      embedding_target: activeTarget,
      dimension: 1,
      status: 'ready',
      expected_items: 1,
      indexed_items: 1,
      failed_items: 0,
      error: null,
      created_at: NOW,
      started_at: NOW,
      completed_at: NOW,
    };
    const activeMemory: SemanticGenerationRow = { ...active, id: 18, purpose: 'memory' };
    const createdModels: string[] = [];
    const runtime = new SemanticProfileRuntime(
      {
        getProfile: (purpose) => profile(purpose, desired),
        getActiveGeneration: (namespace) => {
          if (namespace === 'code:p7') return active;
          if (namespace === 'code:p10') return { ...active, id: 19, dimension: 2 };
          if (
            namespace === 'snapshot:p7'
            || namespace === 'memory:project:p7'
            || namespace === 'memory:user'
          ) return activeMemory;
          return null;
        },
      },
      EMPTY_PROVIDERS,
      (target) => {
        const model = target.kind === 'disabled' ? 'disabled' : target.model;
        createdModels.push(model);
        return {
          embed: async (texts) => ({ vectors: texts.map(() => [model === 'active/model' ? 17 : 23]), tokens: 0 }),
          embedQuery: async () => ({ vector: [model === 'active/model' ? 17 : 23], tokens: 0 }),
          fingerprint: () => model,
        };
      },
    );

    expect((await runtime.embedding('code').embedQuery('configured')).vector).toEqual([23]);
    const queryEmbedding = runtime.queryEmbedding('code');
    expect(await queryEmbedding.embedQueryForNamespace!('code:p7', 'query')).toMatchObject({
      vector: [17], generationId: 17,
    });
    const memoryQueryEmbedding = runtime.queryEmbedding('memory');
    for (const namespace of ['snapshot:p7', 'memory:project:p7', 'memory:user']) {
      expect((await memoryQueryEmbedding.embedQueryForNamespace!(namespace, 'query')).vector)
        .toEqual([17]);
    }
    desired = { ...desiredTarget, model: 'future/model' };
    expect((await queryEmbedding.embedQueryForNamespace!('code:p7', 'query')).vector).toEqual([17]);
    expect((await memoryQueryEmbedding.embedQueryForNamespace!('snapshot:p7', 'query')).vector)
      .toEqual([17]);
    await expect(queryEmbedding.embedQueryForNamespace!('code:p8', 'query'))
      .rejects.toThrow(/No active semantic generation/);
    await expect(queryEmbedding.embedQueryForNamespace!('code:p10', 'query'))
      .rejects.toThrow(/expects 2 dimensions, got 1/);
    desired = { kind: 'disabled' };
    await expect(queryEmbedding.embedQueryForNamespace!('code:p7', 'query'))
      .rejects.toThrow(/code semantic profile is disabled/);
    expect(createdModels).toEqual(['desired/model', 'active/model']);
    await runtime.dispose();
  });

  it('rejects an active query and write after provider context changes, then accepts a new generation', async () => {
    const target: EmbeddingTarget = {
      kind: 'provider',
      providerId: 'openai-main',
      model: 'same-model',
      protocol: 'openai-embeddings',
    };
    let provider = {
      id: 'openai-main', kind: 'openai', enabled: true,
      base_url: 'https://embeddings-a.example/v1', api_key: 'super-secret-key',
      auth_mode: 'api_key', extra: { deployment: 'primary' },
    };
    const providers = {
      getProvider: () => provider,
      getOAuth: () => null,
    } as unknown as ProviderStore;
    let activeGeneration: SemanticGenerationRow | null = null;
    let writeGeneration: SemanticGenerationRow | null = null;
    const calls: string[] = [];
    const generation = (id: number, fingerprint: string): SemanticGenerationRow => ({
      id,
      purpose: 'code',
      fingerprint,
      embedding_target: target,
      dimension: 2,
      status: id === 1 ? 'ready' : 'building',
      expected_items: 1,
      indexed_items: id === 1 ? 1 : 0,
      failed_items: 0,
      error: null,
      created_at: NOW,
      started_at: NOW,
      completed_at: id === 1 ? NOW : null,
    });
    const runtime = new SemanticProfileRuntime(
      {
        getProfile: (purpose) => profile(purpose, target),
        getActiveGeneration: () => activeGeneration,
        getWriteGeneration: () => writeGeneration,
      },
      providers,
      (_target) => {
        const endpoint = provider.base_url;
        return {
          embed: async (texts) => {
            calls.push(`documents:${endpoint}`);
            return { vectors: texts.map(() => [1, 0]), tokens: texts.length };
          },
          embedQuery: async () => {
            calls.push(`query:${endpoint}`);
            return { vector: [1, 0], tokens: 1 };
          },
          // Deliberately identical across endpoints: the context digest, not
          // model/dimension alone, must distinguish these vector spaces.
          fingerprint: () => 'provider:openai-main:same-model:unit-v1',
        };
      },
    );

    const desired = runtime.embedding('code');
    const query = runtime.queryEmbedding('code');
    const fingerprintA = desired.fingerprint!();
    expect(fingerprintA).toMatch(/^semantic-embedding:v2:[0-9a-f]{64}$/);
    expect(fingerprintA).not.toContain(provider.base_url);
    expect(fingerprintA).not.toContain(provider.api_key);
    activeGeneration = generation(1, fingerprintA);
    writeGeneration = activeGeneration;
    const revisionA = query.cacheRevisionForNamespace!('code:p7');
    await expect(query.embedQueryForNamespace!('code:p7', 'before')).resolves.toMatchObject({
      vector: [1, 0], generationId: 1,
    });
    await expect(desired.embedDocumentsForNamespace!('code:p7', ['before']))
      .resolves.toMatchObject({ writeTarget: { generationId: 1, embeddingFingerprint: fingerprintA } });

    provider = { ...provider, base_url: 'https://embeddings-b.example/v1' };
    const fingerprintB = desired.fingerprint!();
    expect(fingerprintB).not.toBe(fingerprintA);
    expect(query.cacheRevisionForNamespace!('code:p7')).not.toBe(revisionA);
    const callsBeforeMismatch = calls.length;
    await expect(query.embedQueryForNamespace!('code:p7', 'stale'))
      .rejects.toThrow(/backend context no longer matches/);
    await expect(desired.embedDocumentsForNamespace!('code:p7', ['stale']))
      .rejects.toThrow(/fingerprint does not match/);
    // Both guards run before any request can reach the replacement backend.
    expect(calls).toHaveLength(callsBeforeMismatch);

    const replacement = generation(2, fingerprintB);
    activeGeneration = { ...replacement, status: 'ready', indexed_items: 1, completed_at: NOW };
    writeGeneration = replacement;
    await expect(query.embedQueryForNamespace!('code:p7', 'after')).resolves.toMatchObject({
      vector: [1, 0], generationId: 2,
    });
    await expect(desired.embedDocumentsForNamespace!('code:p7', ['after']))
      .resolves.toMatchObject({ writeTarget: { generationId: 2, embeddingFingerprint: fingerprintB } });
    expect(calls).toEqual([
      'query:https://embeddings-a.example/v1',
      'documents:https://embeddings-a.example/v1',
      'query:https://embeddings-b.example/v1',
      'documents:https://embeddings-b.example/v1',
    ]);
    await runtime.dispose();
  });
});
