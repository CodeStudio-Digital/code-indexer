import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type {
  EmbeddingTarget,
  RerankerTarget,
  SemanticCapability,
  SemanticGenerationRow,
  SemanticJobRow,
  SemanticJobStatus,
  SemanticModelCatalogRow,
  SemanticNamespaceGenerationRow,
  SemanticProfileRow,
  SemanticPurpose,
  SemanticStore,
} from '@mcp/store/semantic-store.js';

const probeMocks = vi.hoisted(() => ({
  embedding: vi.fn(),
  reranker: vi.fn(),
}));

vi.mock('@mcp/indexer/search/semantic-targets.js', () => ({
  probeEmbeddingTarget: probeMocks.embedding,
  probeRerankerTarget: probeMocks.reranker,
}));

import { semanticRouter } from '../semantic.routes.js';

const NOW = '2026-07-15 12:00:00';

class FakeSemanticStore {
  profiles: SemanticProfileRow[] = [];
  models: SemanticModelCatalogRow[] = [];
  generations: SemanticGenerationRow[] = [];
  namespaces: SemanticNamespaceGenerationRow[] = [];
  jobs: SemanticJobRow[] = [];
  nextJobId = 1;

  listProfiles(): SemanticProfileRow[] {
    return this.profiles;
  }

  getProfile(purpose: SemanticPurpose): SemanticProfileRow | null {
    return this.profiles.find((profile) => profile.purpose === purpose) ?? null;
  }

  upsertProfile(input: {
    purpose: SemanticPurpose;
    embedding_target: EmbeddingTarget;
    reranker_target: RerankerTarget;
  }): SemanticProfileRow {
    const existing = this.profiles.find((profile) => profile.purpose === input.purpose);
    const row: SemanticProfileRow = {
      ...input,
      created_at: existing?.created_at ?? NOW,
      updated_at: NOW,
    };
    this.profiles = [
      ...this.profiles.filter((profile) => profile.purpose !== input.purpose),
      row,
    ];
    return row;
  }

  listModels(filter: {
    capability?: SemanticCapability;
    source?: SemanticModelCatalogRow['source'];
  } = {}): SemanticModelCatalogRow[] {
    return this.models.filter((model) =>
      (!filter.capability || model.capability === filter.capability)
      && (!filter.source || model.source === filter.source));
  }

  upsertModel(input: {
    id: string;
    capability: SemanticCapability;
    source: SemanticModelCatalogRow['source'];
    provider_id?: string | null;
    model_id: string;
    config?: Record<string, unknown>;
    dimension?: number | null;
    status?: SemanticModelCatalogRow['status'];
    last_probe_error?: string | null;
  }): SemanticModelCatalogRow {
    const existing = this.models.find((model) => model.id === input.id);
    const row: SemanticModelCatalogRow = {
      id: input.id,
      capability: input.capability,
      source: input.source,
      provider_id: input.provider_id ?? null,
      model_id: input.model_id,
      config: input.config ?? {},
      dimension: input.dimension ?? null,
      status: input.status ?? 'unknown',
      last_probe_at: existing?.last_probe_at ?? null,
      last_probe_error: input.last_probe_error ?? null,
      created_at: existing?.created_at ?? NOW,
      updated_at: NOW,
    };
    this.models = [...this.models.filter((model) => model.id !== input.id), row];
    return row;
  }

  recordModelProbe(
    id: string,
    result: { ok: boolean; dimension?: number | null; error?: string | null },
  ): SemanticModelCatalogRow | null {
    const existing = this.models.find((model) => model.id === id);
    if (!existing) return null;
    const row: SemanticModelCatalogRow = {
      ...existing,
      status: result.ok ? 'ready' : 'error',
      dimension: result.dimension ?? existing.dimension,
      last_probe_at: NOW,
      last_probe_error: result.ok ? null : (result.error ?? 'probe failed'),
      updated_at: NOW,
    };
    this.models = [...this.models.filter((model) => model.id !== id), row];
    return row;
  }

  deleteModel(id: string): number {
    const before = this.models.length;
    this.models = this.models.filter((model) => model.id !== id);
    return before - this.models.length;
  }

  listGenerations(): SemanticGenerationRow[] {
    return this.generations;
  }

  listNamespaceGenerations(): SemanticNamespaceGenerationRow[] {
    return this.namespaces;
  }

  enqueueReindexJob(purpose: SemanticPurpose): SemanticJobRow {
    const namespace = `semantic:reindex:${purpose}`;
    const existing = this.jobs.find((job) =>
      job.namespace === namespace && ['pending', 'running', 'paused'].includes(job.status));
    if (existing) {
      if (existing.status === 'paused') {
        existing.status = 'pending';
        existing.error = null;
      }
      return existing;
    }
    const row: SemanticJobRow = {
      id: this.nextJobId++,
      generation_id: null,
      namespace,
      kind: 'build',
      status: 'pending',
      priority: 100,
      cursor: { purpose, attempt: 0 },
      expected_items: 0,
      processed_items: 0,
      failed_items: 0,
      error: null,
      created_at: NOW,
      started_at: null,
      updated_at: NOW,
      completed_at: null,
    };
    this.jobs.push(row);
    return row;
  }

  recoverExpiredReindexJobs(): number {
    return 0;
  }

  claimNextReindexJob(
    workerId: string,
    _leaseMs?: number,
    _nowMs?: number,
    purpose?: SemanticPurpose,
  ): SemanticJobRow | null {
    const namespace = purpose ? `semantic:reindex:${purpose}` : null;
    const row = this.jobs.find((job) =>
      job.status === 'pending' && (!namespace || job.namespace === namespace)) ?? null;
    if (!row) return null;
    row.status = 'running';
    row.started_at ??= NOW;
    row.cursor = {
      ...(row.cursor ?? {}),
      attempt: Number(row.cursor?.attempt ?? 0) + 1,
      lease_owner: workerId,
      lease_expires_at_ms: Date.now() + 30_000,
    };
    return row;
  }

  renewReindexJobLease(): boolean {
    return true;
  }

  listJobs(filter: { status?: SemanticJobStatus } = {}): SemanticJobRow[] {
    return this.jobs.filter((job) => !filter.status || job.status === filter.status);
  }

  updateJob(id: number, patch: Partial<SemanticJobRow>): SemanticJobRow | null {
    const row = this.jobs.find((job) => job.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updated_at: NOW });
    if (patch.status === 'completed' || patch.status === 'failed' || patch.status === 'cancelled') {
      row.completed_at = NOW;
    }
    return row;
  }
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function modelRow(input: {
  id: string;
  capability: SemanticCapability;
  providerId?: string;
  model: string;
  status?: SemanticModelCatalogRow['status'];
}): SemanticModelCatalogRow {
  return {
    id: input.id,
    capability: input.capability,
    source: 'custom',
    provider_id: input.providerId ?? null,
    model_id: input.model,
    config: {},
    dimension: null,
    status: input.status ?? 'unknown',
    last_probe_at: null,
    last_probe_error: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

function createHarness() {
  const store = new FakeSemanticStore();
  const providers = {
    listProviders: vi.fn(() => []),
    listModels: vi.fn(() => []),
    getProvider: vi.fn(() => null),
    getOAuth: vi.fn(() => null),
  } as unknown as ProviderStore;
  const reindex = vi.fn(async (purpose: SemanticPurpose) => ({
    purpose,
    generation_id: 41,
  }));
  const cleanupUnusedVectors = vi.fn(async () => ({
    tables_removed: 2,
    items_removed: 120,
    databases_compacted: 1,
    bytes_reclaimed: 4096,
    skipped_referenced: 1,
    failures: [],
  }));
  const namespaceStatus = vi.fn((namespace: string) => ({
    namespace,
    purpose: namespace.startsWith('docs:') ? 'docs' as const : 'memory' as const,
    dbPath: namespace === 'memory:user'
      ? 'D:/data/semantic/memory-vectors.db'
      : 'D:/data/semantic/docs-vectors.db',
    size_bytes: namespace === 'memory:user' ? 2048 : 4096,
    active: null,
    building: null,
    expected_items: 0,
    indexed_items: 0,
    failed_items: 0,
    delta_items: 0,
    last_error: null,
    updated_at: null,
  }));
  const rerankerDiagnostics = vi.fn(async (_purpose: SemanticPurpose) => ({
    policy: 'auto',
    requested_model: 'auto',
    resolved_model: 'Xenova/bge-reranker-base',
    dtype: 'q8',
    estimated_peak_bytes: 760 * 1024 * 1024,
    reserve_bytes: 1024 ** 3,
    execution_provider: 'cpu',
    downgrade_reason: null as string | null,
    last_latency_ms: 18 as number | null,
    enabled: true,
  }));
  const app = semanticRouter(providers, {
    store: store as unknown as SemanticStore,
    reindex,
    cleanupUnusedVectors,
    namespaceStatus,
    probeEmbeddingTarget: (target) => probeMocks.embedding(target, providers),
    probeRerankerTarget: (target) => probeMocks.reranker(target, providers),
    rerankerDiagnostics,
  });
  return {
    app,
    store,
    providers,
    reindex,
    cleanupUnusedVectors,
    namespaceStatus,
    rerankerDiagnostics,
  };
}

describe('semantic admin profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probeMocks.embedding.mockResolvedValue({
      ok: true,
      dimension: 384,
      fingerprint: 'embedding:test',
      latency_ms: 7,
    });
    probeMocks.reranker.mockResolvedValue({
      ok: true,
      latency_ms: 5,
      model: 'Xenova/bge-reranker-base',
    });
  });

  it('lists the three persisted semantic profiles', async () => {
    const { app, store } = createHarness();
    store.profiles = [
      {
        purpose: 'code',
        embedding_target: { kind: 'disabled' },
        reranker_target: { kind: 'disabled' },
        created_at: NOW,
        updated_at: NOW,
      },
      {
        purpose: 'docs',
        embedding_target: { kind: 'disabled' },
        reranker_target: { kind: 'disabled' },
        created_at: NOW,
        updated_at: NOW,
      },
      {
        purpose: 'memory',
        embedding_target: { kind: 'disabled' },
        reranker_target: { kind: 'disabled' },
        created_at: NOW,
        updated_at: NOW,
      },
    ];

    const response = await app.request('/semantic/profiles');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { profiles: SemanticProfileRow[] };
    expect(body.profiles.map((profile) => profile.purpose)).toEqual(['code', 'docs', 'memory']);
  });

  it('gets one profile by purpose and validates missing/invalid purposes', async () => {
    const { app, store } = createHarness();
    store.profiles = [{
      purpose: 'code',
      embedding_target: { kind: 'disabled' },
      reranker_target: { kind: 'disabled' },
      created_at: NOW,
      updated_at: NOW,
    }];

    const found = await app.request('/semantic/profiles/code');
    expect(found.status).toBe(200);
    expect((await found.json() as { profile: SemanticProfileRow }).profile.purpose).toBe('code');

    expect((await app.request('/semantic/profiles/docs')).status).toBe(404);
    expect((await app.request('/semantic/profiles/other')).status).toBe(400);
  });

  it('rejects unknown purposes and unprobed targets', async () => {
    const { app } = createHarness();
    const input = {
      embedding_target: { kind: 'onnx', model: 'Xenova/multilingual-e5-small' },
      reranker_target: { kind: 'disabled' },
    };

    const invalidPurpose = await app.request(
      '/semantic/profiles/other',
      json('PUT', input),
    );
    expect(invalidPurpose.status).toBe(400);

    const unprobed = await app.request('/semantic/profiles/code', json('PUT', input));
    expect(unprobed.status).toBe(400);
    expect((await unprobed.json()) as { error: string }).toEqual({
      error: 'embedding target must pass its probe before it can be saved',
    });
  });

  it('rejects invalid ONNX templates and token limits before probing', async () => {
    const { app } = createHarness();
    const badTemplate = await app.request('/semantic/probe', json('POST', {
      capability: 'embedding',
      target: {
        kind: 'onnx', model: 'custom/embed',
        queryTemplate: 'query without placeholder', documentTemplate: '{text}',
      },
    }));
    expect(badTemplate.status).toBe(400);
    expect(await badTemplate.json()).toEqual({ error: 'queryTemplate must contain {text}', ok: false });

    const badLimit = await app.request('/semantic/probe', json('POST', {
      capability: 'rerank',
      target: { kind: 'onnx', model: 'custom/rerank', maxTokens: 0 },
    }));
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toEqual({ error: 'maxTokens must be a positive number', ok: false });
    expect(probeMocks.embedding).not.toHaveBeenCalled();
    expect(probeMocks.reranker).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before probing or saving FP32 ONNX targets', async () => {
    const { app } = createHarness();
    const target = { kind: 'onnx', model: 'custom/heavy', dtype: 'fp32' };

    const refusedProbe = await app.request('/semantic/probe', json('POST', {
      capability: 'embedding', target,
    }));
    expect(refusedProbe.status).toBe(400);
    expect(await refusedProbe.json()).toEqual({
      error: 'FP32 ONNX may use substantially more memory; explicit confirmation is required',
      ok: false,
    });
    expect(probeMocks.embedding).not.toHaveBeenCalled();

    const confirmedProbe = await app.request('/semantic/probe', json('POST', {
      capability: 'embedding', target, confirm_fp32: true,
    }));
    expect(confirmedProbe.status).toBe(200);

    const refusedSave = await app.request('/semantic/profiles/code', json('PUT', {
      embedding_target: target,
      reranker_target: { kind: 'disabled' },
    }));
    expect(refusedSave.status).toBe(400);

    const confirmedSave = await app.request('/semantic/profiles/code', json('PUT', {
      embedding_target: target,
      reranker_target: { kind: 'disabled' },
      confirm_fp32: true,
    }));
    expect(confirmedSave.status).toBe(200);
  });

  it('normalizes the automatic ONNX reranker to q8 for probe and save', async () => {
    const { app, providers } = createHarness();
    const target = { kind: 'onnx', model: ' auto ' };

    const probe = await app.request('/semantic/probe', json('POST', {
      capability: 'rerank',
      target,
    }));
    expect(probe.status).toBe(200);
    expect(probeMocks.reranker).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'onnx',
      model: 'auto',
      dtype: 'q8',
    }), providers);

    const save = await app.request('/semantic/profiles/code', json('PUT', {
      embedding_target: { kind: 'disabled' },
      reranker_target: target,
    }));
    expect(save.status).toBe(200);
    expect((await save.json()) as { profile: SemanticProfileRow }).toMatchObject({
      profile: {
        purpose: 'code',
        reranker_target: { kind: 'onnx', model: 'auto', dtype: 'q8' },
      },
    });
  });

  it('rejects unknown ONNX dtypes instead of silently changing vector metadata', async () => {
    const { app } = createHarness();
    const response = await app.request('/semantic/probe', json('POST', {
      capability: 'embedding',
      target: { kind: 'onnx', model: 'vendor/model', dtype: 'float64' },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'dtype must be q8, q4, fp16, or fp32',
      ok: false,
    });
    expect(probeMocks.embedding).not.toHaveBeenCalled();
  });

  it('normalizes and saves a profile only after both targets pass their probes', async () => {
    const { app, store, reindex } = createHarness();
    const embedding = { kind: 'onnx', model: ' Xenova/multilingual-e5-small ' };
    const reranker = { kind: 'onnx', model: ' Xenova/bge-reranker-base ' };

    expect(
      (await app.request('/semantic/probe', json('POST', {
        capability: 'embedding',
        target: embedding,
      }))).status,
    ).toBe(200);
    expect(
      (await app.request('/semantic/probe', json('POST', {
        capability: 'rerank',
        target: reranker,
      }))).status,
    ).toBe(200);

    const response = await app.request('/semantic/profiles/code', json('PUT', {
      embedding_target: embedding,
      reranker_target: reranker,
    }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      profile: SemanticProfileRow;
      reindex_job: SemanticJobRow | null;
    };
    expect(body.profile).toMatchObject({
      purpose: 'code',
      embedding_target: {
        kind: 'onnx',
        model: 'Xenova/multilingual-e5-small',
        pooling: 'mean',
        normalize: true,
        queryTemplate: 'query: {text}',
        documentTemplate: 'passage: {text}',
      },
      reranker_target: {
        kind: 'onnx',
        model: 'Xenova/bge-reranker-base',
      },
    });
    expect(store.models).toHaveLength(2);
    expect(store.models.every((model) => model.status === 'ready')).toBe(true);
    expect(body.reindex_job).toBeNull();
    expect(reindex).not.toHaveBeenCalled();
    expect(store.jobs).toEqual([]);
  });

  it('invalidates a successful probe when target parameters change', async () => {
    const { app } = createHarness();
    const target = { kind: 'onnx', model: 'Xenova/multilingual-e5-small' };
    const probe = await app.request('/semantic/probe', json('POST', {
      capability: 'embedding',
      target,
    }));
    expect(probe.status).toBe(200);

    const response = await app.request('/semantic/profiles/code', json('PUT', {
      embedding_target: { ...target, normalize: false },
      reranker_target: { kind: 'disabled' },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'embedding target must pass its probe before it can be saved',
    });
  });

  it('invalidates provider probes when the credential context changes', async () => {
    probeMocks.embedding.mockResolvedValue({
      ok: true,
      dimension: 1536,
      fingerprint: 'provider:test',
      latency_ms: 3,
    });
    const { app, providers } = createHarness();
    let provider = {
      id: 'openai-main',
      name: 'OpenAI',
      kind: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'first-key',
      auth_mode: 'api_key',
      enabled: true,
      use_for_agent: true,
      use_for_coder: true,
      use_for_general: true,
      is_default: true,
      extra: {},
      fallback_provider_id: null,
      created_at: NOW,
      updated_at: NOW,
    };
    vi.mocked(providers.getProvider).mockImplementation(() => provider as never);
    const target = {
      kind: 'provider', providerId: provider.id, model: 'text-embedding-3-small',
      protocol: 'openai-embeddings',
    };

    expect((await app.request('/semantic/probe', json('POST', {
      capability: 'embedding', target,
    }))).status).toBe(200);
    expect((await app.request('/semantic/profiles/code', json('PUT', {
      embedding_target: target,
      reranker_target: { kind: 'disabled' },
    }))).status).toBe(200);

    provider = { ...provider, api_key: 'rotated-key', updated_at: '2026-07-15 12:01:00' };
    const stale = await app.request('/semantic/profiles/code', json('PUT', {
      embedding_target: target,
      reranker_target: { kind: 'disabled' },
    }));
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({
      error: 'embedding target must pass its probe before it can be saved',
    });
  });

  it('allows an explicitly disabled profile without a runtime probe', async () => {
    const { app, store, reindex } = createHarness();
    const response = await app.request('/semantic/profiles/memory', json('PUT', {
      embedding_target: { kind: 'disabled' },
      reranker_target: { kind: 'disabled' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reindex_job: null });
    expect(probeMocks.embedding).not.toHaveBeenCalled();
    expect(probeMocks.reranker).not.toHaveBeenCalled();
    expect(store.jobs).toHaveLength(0);
    expect(reindex).not.toHaveBeenCalled();
  });
});

describe('semantic model catalog and probes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters catalog models by capability and provider', async () => {
    const { app, store } = createHarness();
    store.models = [
      modelRow({ id: 'e:p1', capability: 'embedding', providerId: 'p1', model: 'embed-a' }),
      modelRow({ id: 'e:p2', capability: 'embedding', providerId: 'p2', model: 'embed-b' }),
      modelRow({ id: 'r:p1', capability: 'rerank', providerId: 'p1', model: 'rerank-a' }),
    ];

    const response = await app.request('/semantic/models?capability=embedding&providerId=p1');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: SemanticModelCatalogRow[] };
    expect(body.models.map((model) => model.id)).toEqual(['e:p1']);

    const invalid = await app.request('/semantic/models?capability=vision');
    expect(invalid.status).toBe(400);
  });

  it('removes stale detected rows without touching custom models', async () => {
    const { app, store } = createHarness();
    store.models = [
      { ...modelRow({ id: 'stale', capability: 'embedding', providerId: 'gone', model: 'old' }), source: 'detected' },
      modelRow({ id: 'custom', capability: 'embedding', model: 'manual' }),
    ];

    const response = await app.request('/semantic/models?capability=embedding');
    expect(response.status).toBe(200);
    expect(((await response.json()) as { models: SemanticModelCatalogRow[] }).models.map((model) => model.id))
      .toEqual(['custom']);
    expect(store.models.map((model) => model.id)).toEqual(['custom']);
  });

  it('records a successful embedding probe and exposes its dimension alias', async () => {
    probeMocks.embedding.mockResolvedValue({
      ok: true,
      dimension: 768,
      fingerprint: 'embedding:mock',
      latency_ms: 11,
    });
    const { app, store, providers } = createHarness();
    const response = await app.request('/semantic/probe', json('POST', {
      capability: 'embedding',
      target: { kind: 'local_http', baseUrl: 'http://127.0.0.1:11434/v1/', model: 'nomic-embed' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, dimension: 768, dimensions: 768 });
    expect(probeMocks.embedding).toHaveBeenCalledOnce();
    expect(probeMocks.embedding).toHaveBeenCalledWith(
      {
        kind: 'local_http',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'nomic-embed',
        protocol: 'openai-embeddings',
      },
      providers,
    );
    expect(store.models[0]).toMatchObject({
      capability: 'embedding',
      model_id: 'nomic-embed',
      status: 'ready',
      dimension: 768,
    });
  });

  it('updates the managed ONNX catalog row instead of creating a duplicate', async () => {
    probeMocks.embedding.mockResolvedValue({
      ok: true,
      dimension: 384,
      fingerprint: 'embedding:managed',
      latency_ms: 4,
    });
    const { app, store } = createHarness();
    store.models = [{
      ...modelRow({
        id: 'onnx:Xenova/multilingual-e5-small',
        capability: 'embedding',
        model: 'Xenova/multilingual-e5-small',
      }),
      source: 'default',
    }];

    const response = await app.request('/semantic/probe', json('POST', {
      capability: 'embedding',
      target: { kind: 'onnx', model: 'Xenova/multilingual-e5-small' },
    }));

    expect(response.status).toBe(200);
    expect(store.models).toHaveLength(1);
    expect(store.models[0]).toMatchObject({
      id: 'onnx:Xenova/multilingual-e5-small',
      source: 'default',
      status: 'ready',
      dimension: 384,
    });
  });

  it('keeps custom ONNX catalog entries isolated by capability', async () => {
    probeMocks.embedding.mockResolvedValue({
      ok: true, dimension: 384, fingerprint: 'embedding:shared', latency_ms: 2,
    });
    probeMocks.reranker.mockResolvedValue({
      ok: true, model: 'vendor/shared-model', latency_ms: 2,
    });
    const { app, store } = createHarness();

    expect((await app.request('/semantic/probe', json('POST', {
      capability: 'embedding', target: { kind: 'onnx', model: 'vendor/shared-model' },
    }))).status).toBe(200);
    expect((await app.request('/semantic/probe', json('POST', {
      capability: 'rerank', target: { kind: 'onnx', model: 'vendor/shared-model' },
    }))).status).toBe(200);

    expect(store.models.map((model) => model.id).sort()).toEqual([
      'onnx:embedding:vendor/shared-model',
      'onnx:rerank:vendor/shared-model',
    ]);
  });

  it('records probe failures without calling any real model or network', async () => {
    probeMocks.reranker.mockRejectedValue(new Error('mock endpoint unavailable'));
    const { app, store } = createHarness();
    const response = await app.request('/semantic/probe', json('POST', {
      capability: 'rerank',
      target: {
        kind: 'local_http',
        baseUrl: 'http://localhost:8080',
        model: 'rerank-local',
        protocol: 'cohere-rerank',
      },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'mock endpoint unavailable', ok: false });
    expect(store.models[0]).toMatchObject({
      status: 'error',
      last_probe_error: 'mock endpoint unavailable',
    });
  });

  it('short-circuits disabled probes', async () => {
    const { app } = createHarness();
    const response = await app.request('/semantic/probe', json('POST', {
      capability: 'embedding',
      target: { kind: 'disabled' },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, model: 'disabled', latency_ms: 0 });
    expect(probeMocks.embedding).not.toHaveBeenCalled();
  });
});

describe('semantic generations and reindexing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps externally-published jobs pending until an explicit reindex request', async () => {
    vi.useFakeTimers();
    try {
      const { store, reindex } = createHarness();
      await vi.advanceTimersByTimeAsync(0);
      const external = store.enqueueReindexJob('memory');

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(reindex).not.toHaveBeenCalled();
      expect(store.jobs.find((job) => job.id === external.id)).toMatchObject({
        status: 'pending', processed_items: 0, error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs unused-vector cleanup only after an explicit admin request', async () => {
    const { app, cleanupUnusedVectors } = createHarness();

    expect(cleanupUnusedVectors).not.toHaveBeenCalled();
    const response = await app.request('/semantic/vectors/cleanup-unused', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(cleanupUnusedVectors).toHaveBeenCalledTimes(1);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: { tables_removed: 2, items_removed: 120, bytes_reclaimed: 4096 },
    });
  });

  it('returns generation and namespace progress together', async () => {
    const { app, store, namespaceStatus } = createHarness();
    store.generations = [{
      id: 9,
      purpose: 'code',
      fingerprint: 'fp',
      embedding_target: { kind: 'disabled' },
      dimension: 384,
      status: 'building',
      expected_items: 100,
      indexed_items: 40,
      failed_items: 1,
      error: null,
      created_at: NOW,
      started_at: NOW,
      completed_at: null,
    }];
    store.namespaces = [{
      namespace: 'code:p7',
      purpose: 'code',
      active_generation_id: null,
      building_generation_id: 9,
      expected_items: 100,
      indexed_items: 40,
      failed_items: 1,
      delta_items: 2,
      last_error: null,
      updated_at: NOW,
    }, {
      namespace: 'docs:c12',
      purpose: 'docs',
      active_generation_id: 8,
      building_generation_id: null,
      expected_items: 25,
      indexed_items: 25,
      failed_items: 0,
      delta_items: 0,
      last_error: null,
      updated_at: NOW,
    }];

    const response = await app.request('/semantic/generations');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      generations: [{ id: 9, status: 'building', indexed_items: 40 }],
      namespaces: [
        { namespace: 'code:p7', delta_items: 2 },
        { namespace: 'docs:c12', active_generation_id: 8 },
      ],
      storage: [
        {
          namespace: 'memory:user',
          dbPath: 'D:/data/semantic/memory-vectors.db',
          size_bytes: 2048,
        },
        {
          namespace: 'docs:c12',
          dbPath: 'D:/data/semantic/docs-vectors.db',
          size_bytes: 4096,
        },
      ],
    });
    expect(namespaceStatus.mock.calls.map(([namespace]) => namespace)).toEqual([
      'memory:user',
      'docs:c12',
    ]);
  });

  it('exposes resolved ONNX reranker diagnostics without failing other profile statuses', async () => {
    const { app, store, rerankerDiagnostics } = createHarness();
    store.profiles = [{
      purpose: 'code',
      embedding_target: { kind: 'disabled' },
      reranker_target: { kind: 'onnx', model: 'auto', dtype: 'q8' },
      created_at: NOW,
      updated_at: NOW,
    }, {
      purpose: 'docs',
      embedding_target: { kind: 'disabled' },
      reranker_target: { kind: 'disabled' },
      created_at: NOW,
      updated_at: NOW,
    }];

    const response = await app.request('/semantic/generations');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rerankers: {
        code: {
          target_kind: 'onnx',
          diagnostics: {
            resolved_model: 'Xenova/bge-reranker-base',
            dtype: 'q8',
            estimated_peak_bytes: 760 * 1024 * 1024,
            execution_provider: 'cpu',
            downgrade_reason: null,
            last_latency_ms: 18,
          },
          error: null,
        },
        docs: { target_kind: 'disabled', diagnostics: null, error: null },
      },
    });
    expect(rerankerDiagnostics).toHaveBeenCalledTimes(1);
    expect(rerankerDiagnostics).toHaveBeenCalledWith('code');
  });

  it('isolates worker diagnostic failures by semantic profile', async () => {
    const { app, store, rerankerDiagnostics } = createHarness();
    store.profiles = (['code', 'docs'] as SemanticPurpose[]).map((purpose) => ({
      purpose,
      embedding_target: { kind: 'disabled' },
      reranker_target: { kind: 'onnx', model: 'auto', dtype: 'q8' },
      created_at: NOW,
      updated_at: NOW,
    }));
    rerankerDiagnostics.mockImplementation(async (purpose) => {
      if (purpose === 'code') throw new Error('semantic worker unavailable');
      return {
        policy: 'auto',
        requested_model: 'auto',
        resolved_model: 'mixedbread-ai/mxbai-rerank-xsmall-v1',
        dtype: 'q8',
        estimated_peak_bytes: 320 * 1024 * 1024,
        reserve_bytes: 1024 ** 3,
        execution_provider: 'cpu',
        downgrade_reason: 'memory pressure',
        last_latency_ms: null,
        enabled: true,
      };
    });

    const response = await app.request('/semantic/generations');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rerankers: {
        code: {
          target_kind: 'onnx',
          diagnostics: null,
          error: 'semantic worker unavailable',
        },
        docs: {
          target_kind: 'onnx',
          diagnostics: {
            resolved_model: 'mixedbread-ai/mxbai-rerank-xsmall-v1',
            downgrade_reason: 'memory pressure',
          },
          error: null,
        },
      },
    });
  });

  it('returns 202 before the durable reindex finishes and pauses failures for resume', async () => {
    const { app, reindex, store } = createHarness();
    let release!: (value: { purpose: SemanticPurpose; generation_id: number }) => void;
    reindex.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const acceptedOrTimeout = await Promise.race([
      app.request('/semantic/profiles/code/reindex', { method: 'POST' }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
    ]);
    expect(acceptedOrTimeout).not.toBe('timeout');
    const accepted = acceptedOrTimeout as Response;
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      job: { id: 1, namespace: 'semantic:reindex:code', status: 'pending' },
    });
    expect(reindex).toHaveBeenCalledWith('code');
    expect(store.jobs[0]?.status).toBe('running');

    const duplicate = await app.request('/semantic/profiles/code/reindex', { method: 'POST' });
    expect((await duplicate.json() as { job: SemanticJobRow }).job.id).toBe(1);
    release({ purpose: 'code', generation_id: 41 });
    await vi.waitFor(() => expect(store.jobs[0]?.status).toBe('completed'));

    const invalid = await app.request('/semantic/profiles/other/reindex', { method: 'POST' });
    expect(invalid.status).toBe(400);

    reindex.mockRejectedValueOnce(new Error('build already running'));
    const failed = await app.request('/semantic/profiles/memory/reindex', { method: 'POST' });
    expect(failed.status).toBe(202);
    await vi.waitFor(() => expect(store.jobs.find((job) => job.namespace.endsWith('memory')))
      .toMatchObject({ status: 'paused', error: 'build already running', failed_items: 1 }));

    const resumed = await app.request('/semantic/profiles/memory/reindex', { method: 'POST' });
    expect(resumed.status).toBe(202);
    await vi.waitFor(() => expect(store.jobs.find((job) => job.namespace.endsWith('memory'))?.status)
      .toBe('completed'));
  });

  it('does not wake a pending profile when the operator confirms only the other profile', async () => {
    const { app, reindex, store } = createHarness();
    const staleCode = store.enqueueReindexJob('code');

    const response = await app.request('/semantic/profiles/memory/reindex', { method: 'POST' });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(reindex).toHaveBeenCalledWith('memory'));
    expect(reindex).not.toHaveBeenCalledWith('code');
    expect(store.jobs.find((job) => job.id === staleCode.id)).toMatchObject({ status: 'pending' });
  });
});
