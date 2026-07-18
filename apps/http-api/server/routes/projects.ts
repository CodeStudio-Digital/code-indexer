import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createProjectsHandlers } from '@mcp/api-handlers/projects/index.js';
import { createContext } from '@mcp/api-handlers/context.js';
import { reinstrumentBuilder } from '@mcp/api-handlers/projects/reinstrument.js';
import { visualEdit, type VisualEditBody } from '@mcp/api-handlers/projects/visual-edit.js';
import { ApiError } from '@mcp/api-bus';
import { purgeIgnoredIndexedFiles } from '@mcp/indexer/indexer/purge-ignored.js';
import {
  codeNamespace,
  docNamespace,
  projectMemoryNamespace,
  snapshotNamespace,
} from '@mcp/shared/vector-namespace.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam, parseJsonBody, notFound } from './_helpers.js';

/**
 * Hono routes for /api/projects/* — thin adapters that parse the request,
 * invoke the corresponding handler in `@mcp/api-handlers/projects`, and
 * serialize the result. The handlers are also mounted on Electron IPC
 * (see apps/electron/src/ipc/) so the business logic stays in one place.
 *
 * SSE adaptation: filesystem, git-status, and scaffold producers return
 * async iterables; this file wraps them into Hono's streamSSE frames.
 * Electron instead pumps them onto a MessagePort.
 */
function mapApiError(c: Context, err: unknown) {
  if (err instanceof ApiError) {
    return c.json({ error: err.message, code: err.code, ...(err.details ?? {}) }, err.status as never);
  }
  throw err;
}

export function mountProjectsRoutes(app: Hono, deps: ServerDeps): void {
  const h = createProjectsHandlers(deps);

  app.get('/api/projects', async (c) => {
    try {
      // `?include_loose=1` returns the global-session picker superset (real
      // projects + loose ad-hoc folders, mig 176). Default = the grid list.
      const includeLoose = c.req.query('include_loose') === '1';
      const list = includeLoose
        ? await h.listForGlobalPicker(undefined, createContext())
        : await h.list(undefined, createContext());
      return c.json(list);
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects', async (c) => {
    try {
      const body = await parseJsonBody<Parameters<typeof h.create>[0]>(c);
      return c.json(await h.create(body as Parameters<typeof h.create>[0], createContext()), 201);
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  // Collection-level danger action — wipes every project's data but keeps the
  // rows. Registered before the `:id` routes; it's a distinct literal segment.
  app.post('/api/projects/clear-all-data', async (c) => {
    try {
      return c.json(await h.clearAllData(undefined, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id', async (c) => {
    try {
      return c.json(await h.get({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.patch('/api/projects/:id', async (c) => {
    try {
      const id = parseIdParam(c);
      const body = await parseJsonBody<Omit<Parameters<typeof h.update>[0], 'id'>>(c);
      return c.json(await h.update({ id, ...body }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.delete('/api/projects/:id', async (c) => {
    try {
      return c.json(await h.delete({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  // Re-instrument an existing Builder project for element selection (rewrites
  // the stamp + vite.config, installs @babel/core). The UI then restarts the
  // dev server. Runs the host npm install with the request's abort signal so a
  // client disconnect cancels it.
  app.post('/api/projects/:id/builder/reinstrument', async (c) => {
    try {
      const id = parseIdParam(c);
      return c.json(await reinstrumentBuilder(deps, { id }, c.req.raw.signal));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  // Visual edit — deterministic (no-AI) source rewrite for a stamped element
  // of a Builder project: inline text + Tailwind classes. 409 = stale
  // selection (re-pick), 422 = shape the engine refuses (dynamic className…).
  app.post('/api/projects/:id/builder/visual-edit', async (c) => {
    try {
      const id = parseIdParam(c);
      const body = await parseJsonBody<VisualEditBody>(c);
      return c.json(visualEdit(deps, id, body));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/clear-data', async (c) => {
    try {
      return c.json(await h.clearData({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/activation', async (c) => {
    try {
      const id = parseIdParam(c);
      const body = await parseJsonBody<{ activationId: string; clientId: string }>(c);
      if (typeof body.activationId !== 'string') throw new ApiError('invalid_activation_id', 400);
      if (typeof body.clientId !== 'string') throw new ApiError('invalid_client_id', 400);
      return c.json(await h.activate({ id, activationId: body.activationId, clientId: body.clientId }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.delete('/api/projects/:id/activation', async (c) => {
    try {
      const id = parseIdParam(c);
      const body = await parseJsonBody<{ activationId: string; clientId: string }>(c);
      if (typeof body.activationId !== 'string') throw new ApiError('invalid_activation_id', 400);
      if (typeof body.clientId !== 'string') throw new ApiError('invalid_client_id', 400);
      return c.json(await h.deactivate({ id, activationId: body.activationId, clientId: body.clientId }, createContext()));
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.post('/api/projects/:id/index-ignore/purge', async (c) => {
    try {
      const id = parseIdParam(c);
      if (!deps.db.getProject(id)) return notFound(c);
      const result = await purgeIgnoredIndexedFiles(deps.db, deps.vectorStore, deps.lshIndexingSink, id);
      deps.hybridSearch?.invalidateCache?.();
      deps.projectIndexService.refreshStatus(id);
      return c.json(result);
    } catch (err) {
      return mapApiError(c, err);
    }
  });

  app.get('/api/projects/:id/index-status', async (c) => {
    try {
      return c.json(await h.indexStatus({ id: parseIdParam(c) }, createContext()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFound(c);
      return mapApiError(c, err);
    }
  });

  /** Explicit structural reconciliation. Opening a project already schedules
   * one coalesced pass; this endpoint is the recovery/admin action and never
   * resolves an LLM or embedding provider. */
  app.post('/api/projects/:id/index/structural/reconcile', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    deps.projectIndexService.ensureFresh(id, 'manual');
    const readiness = await deps.projectIndexService.ensureStructuralReady(
      id,
      180_000,
      c.req.raw.signal,
    );
    const status = deps.projectIndexService.getStatus(id);
    const httpStatus = readiness.status === 'ready' ? 200 : 202;
    return c.json({ ok: readiness.status === 'ready', readiness, status }, httpStatus);
  });

  app.get('/api/projects/:id/indexing/jobs', (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    const namespaces = new Set([
      codeNamespace(id),
      snapshotNamespace(id),
      projectMemoryNamespace(id),
      `semantic:reindex:code:p${id}`,
    ]);
    const jobs = deps.semanticStore.listJobs()
      .filter((job) => namespaces.has(job.namespace))
      .sort((left, right) => right.id - left.id);
    return c.json({ project_id: id, jobs });
  });

  app.get('/api/projects/:id/semantic/status', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    const namespaces = [
      codeNamespace(id),
      snapshotNamespace(id),
      projectMemoryNamespace(id),
      ...deps.docStore.listCollectionsForProject(id).map((collection) => docNamespace(collection.id)),
    ];
    const namespaceStatus = namespaces.map((namespace) =>
      deps.localVectorRouter.getNamespaceStatus(namespace));
    const relevantNamespaces = new Set([
      ...namespaces,
      `semantic:reindex:code:p${id}`,
    ]);
    const jobs = deps.semanticStore.listJobs()
      .filter((job) => relevantNamespaces.has(job.namespace))
      .sort((left, right) => right.id - left.id);
    const codeStatus = namespaceStatus.find((row) => row.namespace === codeNamespace(id));
    const generationIds = new Set([
      codeStatus?.active?.generationId,
      codeStatus?.building?.generationId,
    ].filter((value): value is number => typeof value === 'number'));
    const generations = [...generationIds]
      .map((generationId) => deps.semanticStore.getGeneration(generationId))
      .filter((generation): generation is NonNullable<typeof generation> => generation !== null);
    const profile = deps.semanticStore.getProfile('code');
    const automatic = profile?.embedding_target.kind === 'onnx'
      || profile?.embedding_target.kind === 'local_http';
    const rerankerDiagnostics = await (
      deps.semanticProfileRuntime as typeof deps.semanticProfileRuntime & {
        rerankerDiagnostics?: (purpose: 'code' | 'docs' | 'memory') => Promise<unknown> | unknown;
      }
    ).rerankerDiagnostics?.('code') ?? null;
    const diagnostics = rerankerDiagnostics && typeof rerankerDiagnostics === 'object'
      ? rerankerDiagnostics as Record<string, unknown>
      : null;
    const activeGeneration = generations.find((generation) =>
      generation.id === codeStatus?.active?.generationId) ?? null;
    const buildingGeneration = generations.find((generation) =>
      generation.id === codeStatus?.building?.generationId) ?? null;
    const openStatuses = new Set(['pending', 'running', 'paused']);
    const markerNamespace = `semantic:reindex:code:p${id}`;
    const codeJobBelongsToCurrentGeneration = (job: (typeof jobs)[number]) =>
      job.namespace === codeNamespace(id)
      && (job.kind === 'backfill' || job.kind === 'build')
      && (job.generation_id === null ? generationIds.size === 0 : generationIds.has(job.generation_id));
    // Older/global builds did not create a project control marker. Expose the
    // underlying code backfill in that case so the same project surface can
    // resume it instead of pretending there is no recoverable job. Jobs from
    // retired generations must never shadow a healthy active generation.
    const reindexJob = jobs.find((job) =>
      job.namespace === markerNamespace && openStatuses.has(job.status))
      ?? jobs.find((job) => codeJobBelongsToCurrentGeneration(job) && openStatuses.has(job.status))
      ?? jobs.find((job) => job.namespace === markerNamespace)
      ?? jobs.find(codeJobBelongsToCurrentGeneration)
      ?? null;
    return c.json({
      project_id: id,
      profiles: deps.semanticStore.listProfiles(),
      namespaces: namespaceStatus,
      generations,
      active_generation: activeGeneration,
      building_generation: buildingGeneration,
      jobs,
      reindex_job: reindexJob,
      automatic_backfill: {
        enabled: automatic,
        target_kind: profile?.embedding_target.kind ?? 'disabled',
        reason: automatic
          ? 'local_profile'
          : profile?.embedding_target.kind === 'provider'
            ? 'remote_provider_requires_confirmation'
            : 'profile_disabled',
      },
      reranker: rerankerDiagnostics,
      resolved_reranker: diagnostics ? {
        ...diagnostics,
        model: diagnostics.resolved_model ?? diagnostics.requested_model,
        estimated_memory_bytes: diagnostics.estimated_peak_bytes,
      } : null,
    });
  });

  app.post('/api/projects/:id/semantic/reindex', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    const body: { action?: unknown } = await c.req.json<{ action?: unknown }>()
      .catch(() => ({}));
    const action = body.action ?? 'start';
    if (action !== 'start' && action !== 'catchup' && action !== 'resume' && action !== 'rebuild') {
      return c.json({ error: 'action must be start, catchup, resume, or rebuild' }, 400);
    }
    try {
      if (action === 'catchup') {
        queueMicrotask(() => {
          void deps.semanticCoordinator.catchUpCodeProject(id).catch((error) =>
            console.warn(`[semantic] project catchup paused for p${id}: ${
              error instanceof Error ? error.message : String(error)
            }`));
        });
        return c.json({ ok: true, action, scheduled: true }, 202);
      }
      const codeState = deps.localVectorRouter.getNamespaceStatus(codeNamespace(id));
      const currentGenerationIds = new Set([
        codeState.active?.generationId,
        codeState.building?.generationId,
      ].filter((value): value is number => typeof value === 'number'));
      const markerNamespace = `semantic:reindex:code:p${id}`;
      const pausedJob = action === 'resume'
        ? deps.semanticStore.listJobs().filter((job) =>
            job.status === 'paused'
            && (job.namespace === markerNamespace
              || (job.namespace === codeNamespace(id)
                && (job.kind === 'backfill' || job.kind === 'build')
                && (job.generation_id === null
                  ? currentGenerationIds.size === 0
                  : currentGenerationIds.has(job.generation_id)))))
          .sort((left, right) => right.id - left.id)[0]
        : undefined;
      const job = pausedJob
        ? deps.semanticCoordinator.resumeJob(pausedJob.id)
        : deps.semanticCoordinator.enqueueCodeProjectReindex(id, action === 'rebuild');
      return c.json({ ok: true, action, job }, 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post('/api/projects/:id/semantic/vectors/cleanup-unused', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    try {
      return c.json({
        ok: true,
        result: await deps.semanticCoordinator.cleanupUnusedVectors(id),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.post('/api/projects/:id/semantic/jobs/:jobId/pause', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    const jobId = Number(c.req.param('jobId'));
    if (!Number.isSafeInteger(jobId) || jobId < 1) return c.json({ error: 'invalid job id' }, 400);
    const job = deps.semanticStore.getJob(jobId);
    const allowed = new Set([
      codeNamespace(id),
      snapshotNamespace(id),
      projectMemoryNamespace(id),
      `semantic:reindex:code:p${id}`,
    ]);
    if (!job || !allowed.has(job.namespace)) return notFound(c);
    const coordinator = deps.semanticCoordinator as typeof deps.semanticCoordinator & {
      pauseJob?: (id: number) => Promise<unknown> | unknown;
    };
    const paused = coordinator.pauseJob
      ? await coordinator.pauseJob(jobId)
      : deps.semanticStore.updateJob(jobId, {
          status: 'paused',
          error: 'paused by user',
        });
    return c.json({ ok: true, job: paused ?? deps.semanticStore.getJob(jobId) });
  });

  /** Live filesystem events (SSE) — coalesced batches from the watcher. */
  app.get('/api/projects/:id/fs-events/stream', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const frame of h.fsEventsStream({ id }, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: 'fs', data: JSON.stringify(frame) });
        }
      } finally {
        await stream.close();
      }
    });
  });

  /** Live git-metadata stream (SSE) — branch switches + ref/sequencer changes. */
  app.get('/api/projects/:id/git-meta/stream', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const frame of h.gitMetaStream({ id }, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: 'git', data: JSON.stringify(frame) });
        }
      } finally {
        await stream.close();
      }
    });
  });

  /** Live status stream (SSE) — initial frame + one per transition. */
  app.get('/api/projects/:id/index-status/stream', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    return streamSSE(c, async (stream) => {
      let seq = 0;
      try {
        for await (const status of h.indexStatusStream({ id }, createContext())) {
          await stream.writeSSE({ id: String(seq++), event: 'status', data: JSON.stringify(status) });
        }
      } finally {
        await stream.close();
      }
    });
  });

}
