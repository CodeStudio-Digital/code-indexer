import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type { LocalVectorNamespaceStatus } from '@mcp/store/local-vector-router.js';
import {
  SemanticStore,
  type EmbeddingTarget,
  type RerankerTarget,
  type SemanticCapability,
  type SemanticJobRow,
  type SemanticPurpose,
} from '@mcp/store/semantic-store.js';
import type {
  probeEmbeddingTarget,
  probeRerankerTarget,
} from '@mcp/indexer/search/semantic-targets.js';
import { semanticTargetContextFingerprint } from '@mcp/indexer/search/semantic-fingerprint.js';
import { resolveProviderSpec } from './model-discovery/index.js';

export interface SemanticAdminRuntime {
  store: SemanticStore;
  reindex(purpose: SemanticPurpose): Promise<unknown>;
  cleanupUnusedVectors(): Promise<unknown>;
  namespaceStatus(namespace: string): LocalVectorNamespaceStatus;
  /** Worker-backed in production. Requiring these callbacks prevents an
   * omitted composition hook from loading ONNX in the HTTP/main process. */
  probeEmbeddingTarget(target: EmbeddingTarget): ReturnType<typeof probeEmbeddingTarget>;
  probeRerankerTarget(target: RerankerTarget): ReturnType<typeof probeRerankerTarget>;
  /** Metadata-only worker RPC. It must never instantiate ONNX in the HTTP or
   * Electron main process. */
  rerankerDiagnostics?(purpose: SemanticPurpose): Promise<unknown> | unknown;
}

export interface SemanticRerankerStatus {
  target_kind: RerankerTarget['kind'] | 'missing';
  diagnostics: Record<string, unknown> | null;
  error: string | null;
}

const REINDEX_NAMESPACE_PREFIX = 'semantic:reindex:';
const REINDEX_LEASE_MS = 30_000;

function reindexPurpose(job: SemanticJobRow): SemanticPurpose | null {
  const fromCursor = job.cursor?.purpose;
  if (fromCursor === 'code' || fromCursor === 'knowledge') return fromCursor;
  const fromNamespace = job.namespace.slice(REINDEX_NAMESPACE_PREFIX.length);
  return isPurpose(fromNamespace) ? fromNamespace : null;
}

function withoutLease(cursor: Record<string, unknown> | null): Record<string, unknown> {
  const next = { ...(cursor ?? {}) };
  delete next.lease_owner;
  delete next.lease_expires_at_ms;
  return next;
}

function assertReindexSucceeded(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const failed = (result as { failed_namespaces?: unknown }).failed_namespaces;
  if (!Array.isArray(failed) || failed.length === 0) return;
  const details = failed.map((entry) => {
    if (!entry || typeof entry !== 'object') return String(entry);
    const row = entry as { namespace?: unknown; error?: unknown };
    return `${String(row.namespace ?? 'unknown')}: ${String(row.error ?? 'failed')}`;
  });
  throw new Error(`reindex paused with ${failed.length} failed namespace(s): ${details.join('; ')}`);
}

/** Small durable consumer for control-plane reindex requests. The heavy build
 * starts only after the HTTP handler has returned its 202 response. */
class SemanticReindexDispatcher {
  private draining: Promise<void> | null = null;
  private readonly requestedPurposes = new Set<SemanticPurpose>();
  private readonly workerId = `semantic-admin:${process.pid}:${Math.random().toString(16).slice(2)}`;

  constructor(private readonly runtime: SemanticAdminRuntime) {
    // Normalize expired leases for visibility, but never resume them merely
    // because the application started. Only enqueue() is an execution wake-up.
    this.runtime.store.recoverExpiredReindexJobs();
  }

  enqueue(purpose: SemanticPurpose): SemanticJobRow {
    const job = this.runtime.store.enqueueReindexJob(purpose);
    this.requestedPurposes.add(purpose);
    this.kick();
    return job;
  }

  private kick(): void {
    if (this.draining) return;
    queueMicrotask(() => {
      if (this.draining) return;
      this.draining = this.drain().finally(() => {
        this.draining = null;
        if (this.requestedPurposes.size > 0) this.kick();
      });
    });
  }

  private async drain(): Promise<void> {
    while (this.requestedPurposes.size > 0) {
      const purposeToRun = this.requestedPurposes.values().next().value as SemanticPurpose;
      this.requestedPurposes.delete(purposeToRun);
      // A click wakes only the purpose the operator confirmed. A pending job
      // intentionally preserved across restart must not be started as a side
      // effect of confirming the other profile.
      const job = this.runtime.store.claimNextReindexJob(
        this.workerId,
        REINDEX_LEASE_MS,
        Date.now(),
        purposeToRun,
      );
      if (!job) continue;
      const purpose = reindexPurpose(job);
      if (!purpose) {
        this.runtime.store.updateJob(job.id, {
          status: 'failed',
          cursor: withoutLease(job.cursor),
          failed_items: Math.max(1, job.failed_items),
          error: `invalid reindex job namespace: ${job.namespace}`,
        });
        continue;
      }

      const heartbeat = setInterval(() => {
        this.runtime.store.renewReindexJobLease(job.id, this.workerId, REINDEX_LEASE_MS);
      }, Math.max(1_000, Math.floor(REINDEX_LEASE_MS / 3)));
      heartbeat.unref?.();
      try {
        const result = await this.runtime.reindex(purpose);
        assertReindexSucceeded(result);
        this.runtime.store.updateJob(job.id, {
          status: 'completed',
          cursor: { ...withoutLease(job.cursor), result },
          processed_items: 1,
          error: null,
        });
      } catch (error) {
        // Provider/model failures are resumable. A later POST changes this
        // paused row back to pending without losing its attempt history.
        this.runtime.store.updateJob(job.id, {
          status: 'paused',
          cursor: withoutLease(job.cursor),
          failed_items: job.failed_items + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        clearInterval(heartbeat);
      }
    }
  }
}

function isPurpose(value: string): value is SemanticPurpose {
  return value === 'code' || value === 'knowledge';
}

async function readRerankerStatus(
  runtime: SemanticAdminRuntime,
  purpose: SemanticPurpose,
): Promise<SemanticRerankerStatus> {
  const target = runtime.store.getProfile(purpose)?.reranker_target;
  if (!target) return { target_kind: 'missing', diagnostics: null, error: null };
  if (target.kind !== 'onnx') {
    return { target_kind: target.kind, diagnostics: null, error: null };
  }
  if (!runtime.rerankerDiagnostics) {
    return {
      target_kind: target.kind,
      diagnostics: null,
      error: 'semantic worker diagnostics are unavailable',
    };
  }
  try {
    const value = await runtime.rerankerDiagnostics(purpose);
    return {
      target_kind: target.kind,
      diagnostics: value && typeof value === 'object'
        ? value as Record<string, unknown>
        : null,
      error: null,
    };
  } catch (error) {
    return {
      target_kind: target.kind,
      diagnostics: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function shortHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex').slice(0, 16);
}

/** Bind an approved target to the provider configuration/authentication that
 * actually passed the probe. Only this digest is persisted; credentials never
 * enter the semantic catalog JSON. */
function probeFingerprint(
  target: EmbeddingTarget | RerankerTarget,
  providers: ProviderStore,
): string {
  return semanticTargetContextFingerprint(target, providers);
}

function catalogTarget(config: Record<string, unknown> | undefined): unknown {
  return config && 'target' in config ? config.target : config;
}

function catalogProbeFingerprint(config: Record<string, unknown> | undefined): string | null {
  return config && typeof config.probe_fingerprint === 'string'
    ? config.probe_fingerprint
    : null;
}

function normalizeMaxTokens(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error('maxTokens must be a positive number');
  }
  return Math.floor(value);
}

function normalizeOnnxDtype(value: unknown): 'q8' | 'q4' | 'fp16' | 'fp32' {
  if (value === undefined || value === null || value === '') return 'q8';
  if (value === 'q8' || value === 'q4' || value === 'fp16' || value === 'fp32') return value;
  throw new Error('dtype must be q8, q4, fp16, or fp32');
}

function normalizeTemplate(value: unknown, fallback: string, label: string): string {
  const template = typeof value === 'string' ? value : fallback;
  if (!template.includes('{text}')) throw new Error(`${label} must contain {text}`);
  return template;
}

function catalogId(
  capability: SemanticCapability,
  target: EmbeddingTarget | RerankerTarget,
): string | null {
  if (target.kind === 'disabled') return null;
  // Preserve migration 227's managed default IDs, while custom ONNX entries
  // include the capability so one repository can expose multiple tasks.
  if (target.kind === 'onnx') {
    const managed = (capability === 'embedding' && target.model === 'Xenova/multilingual-e5-small')
      || (capability === 'rerank' && target.model === 'Xenova/bge-reranker-base');
    return managed ? `onnx:${target.model}` : `onnx:${capability}:${target.model}`;
  }
  if (target.kind === 'provider') {
    return `provider:${target.providerId}:${capability}:${target.protocol}:${target.model}`;
  }
  return `local_http:${capability}:${shortHash(target)}`;
}

function normalizeEmbeddingTarget(value: unknown): EmbeddingTarget {
  const target = value as Partial<EmbeddingTarget> & Record<string, unknown>;
  if (target.kind === 'disabled') return { kind: 'disabled' };
  const model = typeof target.model === 'string' ? target.model.trim() : '';
  if (!model) throw new Error('embedding target model is required');
  if (target.kind === 'onnx') {
    const e5 = /(?:^|[/_-])e5(?:$|[/_.-])/i.test(model);
    return {
      kind: 'onnx',
      model,
      revision: typeof target.revision === 'string' && target.revision ? target.revision : undefined,
      cacheDir: typeof target.cacheDir === 'string' && target.cacheDir ? target.cacheDir : undefined,
      dtype: normalizeOnnxDtype(target.dtype),
      pooling: target.pooling === 'cls' ? 'cls' : 'mean',
      normalize: target.normalize !== false,
      queryTemplate: normalizeTemplate(
        target.queryTemplate,
        e5 ? 'query: {text}' : '{text}',
        'queryTemplate',
      ),
      documentTemplate: normalizeTemplate(
        target.documentTemplate,
        e5 ? 'passage: {text}' : '{text}',
        'documentTemplate',
      ),
      maxTokens: normalizeMaxTokens(target.maxTokens),
    };
  }
  if (target.kind === 'local_http') {
    const baseUrl = typeof target.baseUrl === 'string' ? target.baseUrl.trim().replace(/\/+$/, '') : '';
    if (!baseUrl) throw new Error('local_http baseUrl is required');
    return { kind: 'local_http', baseUrl, model, protocol: 'openai-embeddings' };
  }
  if (target.kind === 'provider') {
    const providerId = typeof target.providerId === 'string' ? target.providerId.trim() : '';
    if (!providerId) throw new Error('embedding providerId is required');
    const protocol = target.protocol === 'cloudflare' || target.protocol === 'bedrock'
      ? target.protocol
      : 'openai-embeddings';
    return { kind: 'provider', providerId, model, protocol };
  }
  throw new Error('invalid embedding target kind');
}

function normalizeRerankerTarget(value: unknown): RerankerTarget {
  const target = value as Partial<RerankerTarget> & Record<string, unknown>;
  if (target.kind === 'disabled') return { kind: 'disabled' };
  const model = typeof target.model === 'string' ? target.model.trim() : '';
  if (!model) throw new Error('reranker target model is required');
  if (target.kind === 'onnx') {
    return {
      kind: 'onnx',
      model,
      revision: typeof target.revision === 'string' && target.revision ? target.revision : undefined,
      cacheDir: typeof target.cacheDir === 'string' && target.cacheDir ? target.cacheDir : undefined,
      dtype: normalizeOnnxDtype(target.dtype),
      maxTokens: normalizeMaxTokens(target.maxTokens),
    };
  }
  if (target.kind === 'local_http') {
    const baseUrl = typeof target.baseUrl === 'string' ? target.baseUrl.trim().replace(/\/+$/, '') : '';
    if (!baseUrl) throw new Error('local_http baseUrl is required');
    return {
      kind: 'local_http',
      baseUrl,
      model,
      protocol: target.protocol === 'openai-rerank' ? 'openai-rerank' : 'cohere-rerank',
    };
  }
  if (target.kind === 'provider') {
    const providerId = typeof target.providerId === 'string' ? target.providerId.trim() : '';
    if (!providerId) throw new Error('reranker providerId is required');
    const protocol = target.protocol === 'cloudflare' || target.protocol === 'bedrock'
      ? target.protocol
      : target.protocol === 'openai-rerank'
        ? 'openai-rerank'
        : 'cohere-rerank';
    return { kind: 'provider', providerId, model, protocol };
  }
  throw new Error('invalid reranker target kind');
}

function requiresHeavyFp32Confirmation(
  ...targets: Array<EmbeddingTarget | RerankerTarget>
): boolean {
  return targets.some((target) => target.kind === 'onnx' && target.dtype === 'fp32');
}

function assertHeavyFp32Confirmed(
  confirmed: unknown,
  ...targets: Array<EmbeddingTarget | RerankerTarget>
): void {
  if (requiresHeavyFp32Confirmation(...targets) && confirmed !== true) {
    throw new Error('FP32 ONNX may use substantially more memory; explicit confirmation is required');
  }
}

function targetModel(target: EmbeddingTarget | RerankerTarget): string {
  return target.kind === 'disabled' ? 'disabled' : target.model;
}

function targetProvider(target: EmbeddingTarget | RerankerTarget): string | null {
  return target.kind === 'provider' ? target.providerId : null;
}

function syncDetectedModels(semantic: SemanticStore, providers: ProviderStore): void {
  const current = new Map(semantic.listModels().map((model) => [model.id, model]));
  const detected = new Set<string>();
  for (const provider of providers.listProviders().filter((row) => row.enabled)) {
    const spec = resolveProviderSpec(provider.kind);
    if (!spec?.semantic) continue;
    for (const capability of ['embedding', 'rerank'] as const) {
      const descriptor = capability === 'embedding' ? spec.semantic.embedding : spec.semantic.rerank;
      if (!descriptor) continue;
      const discovered = providers.listModels(provider.id, true).map((model) => model.model_id);
      const configuredPatterns = descriptor.modelPatterns ?? [];
      const patterns = configuredPatterns.map((pattern) => {
        try { return new RegExp(pattern, 'i'); } catch { return null; }
      }).filter((pattern): pattern is RegExp => pattern !== null);
      const candidates = new Set(descriptor.defaultModels ?? []);
      for (const rawModel of discovered) {
        const model = rawModel.trim();
        if (!model) continue;
        if (configuredPatterns.length === 0 || patterns.some((pattern) => pattern.test(model))) {
          candidates.add(model);
        }
      }
      for (const model of candidates) {
        const target = {
          kind: 'provider', providerId: provider.id, model, protocol: descriptor.protocol,
        } as EmbeddingTarget | RerankerTarget;
        const id = catalogId(capability, target)!;
        detected.add(id);
        const existing = current.get(id);
        const fingerprint = probeFingerprint(target, providers);
        const sameProbe = shortHash(catalogTarget(existing?.config)) === shortHash(target)
          && catalogProbeFingerprint(existing?.config) === fingerprint;
        semantic.upsertModel({
          id,
          capability,
          source: 'detected',
          provider_id: provider.id,
          model_id: model,
          config: { target, probe_fingerprint: fingerprint },
          dimension: sameProbe ? existing?.dimension : null,
          status: sameProbe ? (existing?.status ?? 'unknown') : 'unknown',
          last_probe_error: sameProbe ? existing?.last_probe_error : null,
        });
      }
    }
  }
  for (const model of semantic.listModels({ source: 'detected' })) {
    if (!detected.has(model.id)) semantic.deleteModel(model.id);
  }
}

function requireSuccessfulProbe(
  semantic: SemanticStore,
  providers: ProviderStore,
  capability: SemanticCapability,
  target: EmbeddingTarget | RerankerTarget,
): void {
  const id = catalogId(capability, target);
  if (!id) return;
  const model = semantic.listModels({ capability }).find((row) => row.id === id);
  const probedTarget = catalogTarget(model?.config);
  // IDs intentionally remain stable so catalog entries do not multiply when
  // protocol details change. Saving, however, must match the complete target
  // that was probed — model name alone is not sufficient.
  if (
    !model
    || model.status !== 'ready'
    || shortHash(probedTarget) !== shortHash(target)
    || catalogProbeFingerprint(model.config) !== probeFingerprint(target, providers)
  ) {
    throw new Error(`${capability} target must pass its probe before it can be saved`);
  }
}

export function semanticRouter(
  providers: ProviderStore,
  runtime: SemanticAdminRuntime,
): Hono {
  const app = new Hono();
  const reindexDispatcher = new SemanticReindexDispatcher(runtime);

  app.get('/semantic/profiles', (c) => c.json({ profiles: runtime.store.listProfiles() }));

  app.get('/semantic/profiles/:purpose', (c) => {
    const purpose = c.req.param('purpose');
    if (!isPurpose(purpose)) return c.json({ error: 'purpose must be code or knowledge' }, 400);
    const profile = runtime.store.getProfile(purpose);
    return profile
      ? c.json({ profile })
      : c.json({ error: `semantic profile ${purpose} was not found` }, 404);
  });

  app.put('/semantic/profiles/:purpose', async (c) => {
    const purpose = c.req.param('purpose');
    if (!isPurpose(purpose)) return c.json({ error: 'purpose must be code or knowledge' }, 400);
    try {
      const body = await c.req.json<{
        embedding_target?: unknown;
        reranker_target?: unknown;
        confirm_fp32?: boolean;
      }>();
      const embeddingTarget = normalizeEmbeddingTarget(body.embedding_target);
      const rerankerTarget = normalizeRerankerTarget(body.reranker_target);
      assertHeavyFp32Confirmed(body.confirm_fp32, embeddingTarget, rerankerTarget);
      requireSuccessfulProbe(runtime.store, providers, 'embedding', embeddingTarget);
      requireSuccessfulProbe(runtime.store, providers, 'rerank', rerankerTarget);
      const profile = runtime.store.upsertProfile({
        purpose,
        embedding_target: embeddingTarget,
        reranker_target: rerankerTarget,
      });
      // Saving configuration is side-effect free. The operator chooses a
      // global or per-project reindex explicitly after reviewing the profile.
      return c.json({ profile, reindex_job: null });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.get('/semantic/models', (c) => {
    syncDetectedModels(runtime.store, providers);
    const capabilityParam = c.req.query('capability');
    if (capabilityParam && capabilityParam !== 'embedding' && capabilityParam !== 'rerank') {
      return c.json({ error: 'capability must be embedding or rerank' }, 400);
    }
    const capability: SemanticCapability | undefined = capabilityParam === 'embedding' || capabilityParam === 'rerank'
      ? capabilityParam
      : undefined;
    const providerId = c.req.query('providerId') ?? c.req.query('provider_id');
    let models = runtime.store.listModels(capability ? { capability } : {});
    if (providerId) models = models.filter((model) => model.provider_id === providerId);
    return c.json({ models });
  });

  app.post('/semantic/probe', async (c) => {
    let id: string | null = null;
    let fingerprint: string | null = null;
    try {
      const body = await c.req.json<{
        capability?: SemanticCapability;
        target?: unknown;
        confirm_fp32?: boolean;
      }>();
      if (body.capability !== 'embedding' && body.capability !== 'rerank') {
        return c.json({ error: 'capability must be embedding or rerank' }, 400);
      }
      const target = body.capability === 'embedding'
        ? normalizeEmbeddingTarget(body.target)
        : normalizeRerankerTarget(body.target);
      assertHeavyFp32Confirmed(body.confirm_fp32, target);
      id = catalogId(body.capability, target);
      if (target.kind === 'disabled') return c.json({ ok: true, model: 'disabled', latency_ms: 0 });
      fingerprint = probeFingerprint(target, providers);
      const existing = id
        ? runtime.store.listModels({ capability: body.capability }).find((model) => model.id === id)
        : null;
      if (id) {
        runtime.store.upsertModel({
          id,
          capability: body.capability,
          source: existing?.source ?? 'custom',
          provider_id: targetProvider(target),
          model_id: targetModel(target),
          config: { target, probe_fingerprint: fingerprint },
          dimension: existing?.dimension,
          // A changed target/auth context is never considered ready while its
          // new probe is still in flight.
          status: 'unknown',
          last_probe_error: null,
        });
      }
      const result = body.capability === 'embedding'
        ? await runtime.probeEmbeddingTarget(target as EmbeddingTarget)
        : await runtime.probeRerankerTarget(target as RerankerTarget);
      if (id) {
        const current = runtime.store.listModels({ capability: body.capability }).find((model) => model.id === id);
        if (catalogProbeFingerprint(current?.config) !== fingerprint) {
          throw new Error('probe result was superseded by a newer target configuration');
        }
        runtime.store.recordModelProbe(id, {
          ok: true,
          dimension: 'dimension' in result ? result.dimension : null,
        });
      }
      return c.json({
        ...result,
        dimensions: 'dimension' in result ? result.dimension : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (id) {
        const current = runtime.store.listModels().find((model) => model.id === id);
        if (catalogProbeFingerprint(current?.config) === fingerprint) {
          runtime.store.recordModelProbe(id, { ok: false, error: message });
        }
      }
      return c.json({ error: message, ok: false }, 400);
    }
  });

  app.get('/semantic/generations', async (c) => {
    const namespaces = runtime.store.listNamespaceGenerations();
    const globalNamespaces = [
      'memory:user',
      ...namespaces
        .map((namespace) => namespace.namespace)
        .filter((namespace) => namespace.startsWith('docs:')),
    ];
    const [codeReranker, knowledgeReranker] = await Promise.all([
      readRerankerStatus(runtime, 'code'),
      readRerankerStatus(runtime, 'knowledge'),
    ]);
    return c.json({
      generations: runtime.store.listGenerations(),
      namespaces,
      jobs: runtime.store.listJobs(),
      storage: [...new Set(globalNamespaces)].map((namespace) => runtime.namespaceStatus(namespace)),
      rerankers: {
        code: codeReranker,
        knowledge: knowledgeReranker,
      },
    });
  });

  app.post('/semantic/vectors/cleanup-unused', async (c) => {
    try {
      return c.json({ ok: true, result: await runtime.cleanupUnusedVectors() });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.post('/semantic/profiles/:purpose/reindex', (c) => {
    const purpose = c.req.param('purpose');
    if (!isPurpose(purpose)) return c.json({ error: 'purpose must be code or knowledge' }, 400);
    try {
      const job = reindexDispatcher.enqueue(purpose);
      return c.json({ ok: true, job }, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return app;
}
