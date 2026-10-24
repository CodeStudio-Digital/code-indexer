import { type EmbeddingTarget, type RerankerTarget, type SemanticCapability, type SemanticPurpose } from '@mcp/store/semantic-store.js';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import { Hono } from 'hono';
import { type SemanticAdminRuntime, type SemanticRerankerStatus } from './semantic-admin-types.js';
import { SemanticReindexDispatcher } from './semantic-reindex-dispatcher.js';
import { isPurpose, normalizeEmbeddingTarget, normalizeRerankerTarget, assertHeavyFp32Confirmed, requireSuccessfulProbe, syncDetectedModels, catalogId, probeFingerprint, targetProvider, targetModel, catalogProbeFingerprint } from './semantic-target-validation.js';

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

export function semanticRouter(
  providers: ProviderStore,
  runtime: SemanticAdminRuntime,
): Hono {
  const app = new Hono();
  const reindexDispatcher = new SemanticReindexDispatcher(runtime);

  app.get('/semantic/profiles', (c) => c.json({ profiles: runtime.store.listProfiles() }));

  app.get('/semantic/profiles/:purpose', (c) => {
    const purpose = c.req.param('purpose');
    if (!isPurpose(purpose)) return c.json({ error: 'purpose must be code, docs or memory' }, 400);
    const profile = runtime.store.getProfile(purpose);
    return profile
      ? c.json({ profile })
      : c.json({ error: `semantic profile ${purpose} was not found` }, 404);
  });

  app.put('/semantic/profiles/:purpose', async (c) => {
    const purpose = c.req.param('purpose');
    if (!isPurpose(purpose)) return c.json({ error: 'purpose must be code, docs or memory' }, 400);
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
    const [codeReranker, docsReranker, memoryReranker] = await Promise.all([
      readRerankerStatus(runtime, 'code'),
      readRerankerStatus(runtime, 'docs'),
      readRerankerStatus(runtime, 'memory'),
    ]);
    return c.json({
      generations: runtime.store.listGenerations(),
      namespaces,
      jobs: runtime.store.listJobs(),
      storage: [...new Set(globalNamespaces)].map((namespace) => runtime.namespaceStatus(namespace)),
      rerankers: {
        code: codeReranker,
        docs: docsReranker,
        memory: memoryReranker,
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
    if (!isPurpose(purpose)) return c.json({ error: 'purpose must be code, docs or memory' }, 400);
    try {
      const job = reindexDispatcher.enqueue(purpose);
      return c.json({ ok: true, job }, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  return app;
}
