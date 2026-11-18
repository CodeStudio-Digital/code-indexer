import type { Hono } from 'hono';
import { readAgentMemoryCoverage } from '@mcp/store/db/agent-memory-coverage.js';
import type { ServerDeps } from '../deps.js';
import { notFound, parseIdParam } from './_helpers.js';

/** Do not return raw provider errors, which can contain request data or URLs. */
export function memorySemanticFailureCode(error: string | null | undefined): string | null {
  if (!error) return null;
  if (['target_changed','authentication','rate_limit','runtime_unavailable','model_mismatch',
    'storage_busy','timeout','network','incomplete_coverage','embedding_failed'].includes(error)) return error;
  if (/memory_semantic_target_changed/.test(error)) return 'target_changed';
  if (/401|403|unauthorized|api.?key|credential/i.test(error)) return 'authentication';
  if (/429|rate.?limit|quota/i.test(error)) return 'rate_limit';
  if (/NODE_MODULE_VERSION|cannot find module|could not find.*module|módulo especificado|native extension unavailable|vector worker unavailable|runtime_unavailable/i.test(error)) return 'runtime_unavailable';
  if (/dimension|fingerprint|profile.*changed/i.test(error)) return 'model_mismatch';
  if (/SQLITE_BUSY|database is locked/i.test(error)) return 'storage_busy';
  if (/timeout|timed out/i.test(error)) return 'timeout';
  if (/fetch|network|ECONN|connect/i.test(error)) return 'network';
  if (/coverage|missing|not current|reindex|stale/i.test(error)) return 'incomplete_coverage';
  return 'embedding_failed';
}

export function mountAgentMemorySemanticRoutes(app: Hono, deps: ServerDeps): void {
  const repairs = new Map<string, Promise<void>>();
  const repairErrors = new Map<string, string>();
  const stateFor = (projectId: number, scope: 'project' | 'user') => {
    const coverage = readAgentMemoryCoverage(deps.db.raw(), projectId, scope);
    const state = deps.semanticStore.listNamespaceGenerations({ namespace: coverage.namespace })[0];
    const retry = deps.semanticStore.getNamespaceBuildRetry(coverage.namespace);
    const lastRepair = deps.semanticStore.listJobs({ namespace: coverage.namespace, generationId: coverage.generationId, kinds: ['delta','backfill'],
      statuses: ['paused'], order: 'newest', limit: 1 })[0];
    const candidates = [repairErrors.get(coverage.namespace), lastRepair?.error, state?.last_error].map(memorySemanticFailureCode);
    const complete = coverage.live === coverage.indexed && !coverage.failed && !coverage.missing && !coverage.pending;
    const errorCode = complete ? null : candidates.find(code => code && code !== 'embedding_failed') ?? candidates.find(Boolean) ?? null;
    const running = deps.semanticStore.listJobs({ namespace: coverage.namespace, kinds: ['build','backfill','delta'], statuses: ['running'], limit: 1 })
      .some(job => job.status === 'running');
    return { ...coverage, repairing: repairs.has(coverage.namespace) || running,
      blocked: complete ? false : retry?.blocked ?? false, retryAt: complete ? null : retry?.not_before_ms ?? null,
      errorCode };
  };
  app.get('/api/projects/:id/agent-memory/semantic', (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    const target = deps.semanticStore.getProfile('memory')?.embedding_target;
    const enabled = !!target && target.kind !== 'disabled';
    return c.json({ enabled, remote: enabled && target.kind !== 'onnx' && target.kind !== 'local_http',
      embeddingModel: target && target.kind !== 'disabled' ? target.model : null,
      rerankerModel: (() => { const reranker = deps.semanticStore.getProfile('memory')?.reranker_target;
        return reranker && reranker.kind !== 'disabled' ? reranker.model : null; })(),
      project: stateFor(id, 'project'), user: stateFor(0, 'user') });
  });
  app.post('/api/projects/:id/agent-memory/semantic/repair', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    const body = await c.req.json<{ scope?: unknown; confirmRemote?: unknown }>().catch(() => null);
    if (!body || (body.scope !== 'project' && body.scope !== 'user')) return c.json({ error: 'invalid_scope' }, 400);
    const target = deps.semanticStore.getProfile('memory')?.embedding_target;
    if (!target || target.kind === 'disabled') return c.json({ error: 'memory_semantic_disabled' }, 409);
    if (target.kind !== 'onnx' && target.kind !== 'local_http' && body.confirmRemote !== true) {
      return c.json({ error: 'remote_provider_requires_confirmation' }, 409);
    }
    const namespace = body.scope === 'user' ? 'memory:user' : `memory:project:p${id}`;
    if (repairs.has(namespace)) return c.json({ scheduled: true, namespace, alreadyRunning: true }, 202);
    // Durable source watermark: a restart retains the need to reconcile. The
    // explicit repair checks the full live namespace, reusing current vectors.
    const targetKey = JSON.stringify(target);
    const guard = () => {
      if (JSON.stringify(deps.semanticStore.getProfile('memory')?.embedding_target) !== targetKey) {
        throw new Error('memory_semantic_target_changed');
      }
    };
    const job = deps.semanticStore.noteNamespaceMutation({ namespace, itemKeys: ['*'], operation: 'upsert', requiresExplicitReindex: true });
    repairErrors.delete(namespace);
    const run = Promise.resolve().then(() => deps.semanticCoordinator.ensureMemoryNamespace(namespace, true, guard))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const code = memorySemanticFailureCode(message) ?? 'embedding_failed';
        repairErrors.set(namespace, code);
        // Covers failure before a generation/job builder exists as well.
        // Diagnostic persistence must never turn a background repair into an
        // unhandled rejection when another SQLite writer owns the catalog.
        try {
          const current = deps.semanticStore.getJob(job.id);
          if (current && current.status !== 'completed') deps.semanticStore.updateJob(job.id, { status: 'paused', error: code });
        } catch { /* durable mutation remains; in-process diagnostic stays visible */ }
        console.warn(`[memory] semantic repair paused (${namespace}): ${code}`);
      }).finally(() => { if (repairs.get(namespace) === run) repairs.delete(namespace); });
    repairs.set(namespace, run);
    return c.json({ scheduled: true, namespace }, 202);
  });
}
