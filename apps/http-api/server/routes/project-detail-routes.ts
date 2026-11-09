import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';
import { createProjectsHandlers } from '@mcp/api-handlers/projects/index.js';
import { parseIdParam, parseJsonBody, notFound } from './_helpers.js';
import { createContext } from '@mcp/api-handlers/context.js';
import { ApiError } from '@mcp/api-bus';
import { reinstrumentBuilder } from '@mcp/api-handlers/projects/reinstrument.js';
import { visualEdit, type VisualEditBody } from '@mcp/api-handlers/projects/visual-edit.js';
import { codeNamespace, docNamespace, projectMemoryNamespace, snapshotNamespace } from '@mcp/shared/vector-namespace.js';
import { readProjectJobPage, readCurrentProjectJobs } from './project-job-queries.js';
import { purgeIgnoredIndexedFiles } from '@mcp/indexer/indexer/purge-ignored.js';
import { streamSSE } from 'hono/streaming';
import { mountProjectCollectionRoutes } from './project-collection-routes.js';
import { mapApiError } from './project-route-errors.js';

export function mountProjectsRoutes(app: Hono, deps: ServerDeps): void {
  const h = createProjectsHandlers(deps);
  mountProjectCollectionRoutes(app, deps, h);

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

  /** Admin summary in one transport call. The previous UI issued one IPC per
   * project; each request repeated namespace SQL and synchronous file stats,
   * creating a long main-loop queue on larger workspaces. */
  app.get('/api/projects/semantic/status', async (c) => {
    const projects = await h.list(undefined, createContext());
    const profiles = deps.semanticStore.listProfiles();
    // One query for every project's collections. The per-project call in this
    // loop was N synchronous SQLite round-trips in a single main-thread burst.
    const collectionsByProject = deps.docStore.listCollectionsForProjects(
      projects.map((project) => project.id),
    );
    const namespacesByProject = projects.map((project) => [
      codeNamespace(project.id),
      snapshotNamespace(project.id),
      projectMemoryNamespace(project.id),
      ...(collectionsByProject.get(project.id) ?? [])
        .map((collection) => docNamespace(collection.id)),
    ]);
    const allNamespaceStatuses = deps.localVectorRouter.getNamespaceStatuses(
      namespacesByProject.flat(),
    );
    const byNamespace = new Map(allNamespaceStatuses.map(row => [row.namespace, row]));
    const selectedJobs = await readCurrentProjectJobs(deps.semanticJobs, projects.map(project => {
      const code = byNamespace.get(codeNamespace(project.id));
      return { projectId: project.id, generationIds: [...new Set([code?.active?.generationId,
        code?.building?.generationId].filter((value): value is number => typeof value === 'number'))] };
    }), c.req.raw.signal);
    let statusCursor = 0;
    const results = projects.map((project, index) => {
      const nextStatusCursor = statusCursor + namespacesByProject[index].length;
      const namespaces = allNamespaceStatuses.slice(statusCursor, nextStatusCursor);
      statusCursor = nextStatusCursor;
      return {
        project,
        status: {
          project_id: project.id,
          profiles,
          namespaces,
          reindex_job: selectedJobs[index],
        },
        error: null,
      };
    });
    return c.json({ results });
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
    const readiness = await deps.projectIndexService.reconcileStructural(
      id,
      180_000,
      c.req.raw.signal,
    );
    const status = deps.projectIndexService.getStatus(id);
    const httpStatus = readiness.status === 'ready' ? 200 : 202;
    return c.json({ ok: readiness.status === 'ready', readiness, status }, httpStatus);
  });

  app.get('/api/projects/:id/indexing/jobs', async (c) => {
    const id = parseIdParam(c);
    if (!deps.db.getProject(id)) return notFound(c);
    const namespaces = new Set([
      codeNamespace(id),
      snapshotNamespace(id),
      projectMemoryNamespace(id),
      `semantic:reindex:code:p${id}`,
    ]);
    try {
      const page = await readProjectJobPage(c, deps.semanticJobs, [...namespaces]);
      return c.json({ project_id: id, jobs: page.jobs, next_before_id: page.nextBeforeId });
    } catch (error) { return mapApiError(c, error); }
  });

  app.get('/api/projects/:id/semantic/status', async (c) => {
    try {
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
    const page = await readProjectJobPage(c, deps.semanticJobs, [...relevantNamespaces]);
    const jobs = page.jobs;
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
    const searchTelemetry = await (
      deps.hybridSearch as typeof deps.hybridSearch & {
        telemetrySummary?: (projectId: number, periodDays?: number) => Promise<unknown>;
      }
    )?.telemetrySummary?.(id, 30) ?? null;
    const diagnostics = rerankerDiagnostics && typeof rerankerDiagnostics === 'object'
      ? rerankerDiagnostics as Record<string, unknown>
      : null;
    const rerankerTarget = profile?.reranker_target ?? null;
    const rerankerConfigured = !!rerankerTarget && rerankerTarget.kind !== 'disabled';
    const configuredModel = rerankerTarget && 'model' in rerankerTarget
      ? rerankerTarget.model
      : undefined;
    const lastError = diagnostics?.last_error
      ? String(diagnostics.last_error)
      : null;
    const rerankerStatus = !rerankerConfigured
      ? 'disabled'
      : diagnostics?.active === true
        ? 'running'
        : lastError
          ? 'failed'
          : diagnostics?.last_success_at || diagnostics?.last_latency_ms != null
            ? 'active'
            : 'configured';
    const activeGeneration = generations.find((generation) =>
      generation.id === codeStatus?.active?.generationId) ?? null;
    const buildingGeneration = generations.find((generation) =>
      generation.id === codeStatus?.building?.generationId) ?? null;
    // Older/global builds did not create a project control marker. Expose the
    // underlying code backfill in that case so the same project surface can
    // resume it instead of pretending there is no recoverable job. Jobs from
    // retired generations must never shadow a healthy active generation.
    const [reindexJob] = await readCurrentProjectJobs(deps.semanticJobs,
      [{ projectId: id, generationIds: [...generationIds] }], c.req.raw.signal);
    return c.json({
      project_id: id,
      profiles: deps.semanticStore.listProfiles(),
      namespaces: namespaceStatus,
      generations,
      active_generation: activeGeneration,
      building_generation: buildingGeneration,
      jobs,
      next_before_id: page.nextBeforeId,
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
      search_telemetry: searchTelemetry,
      resolved_reranker: rerankerTarget ? {
        ...(diagnostics ?? {}),
        configured: rerankerConfigured,
        status: rerankerStatus,
        target_kind: rerankerTarget.kind,
        model: diagnostics?.resolved_model
          ?? diagnostics?.model
          ?? diagnostics?.requested_model
          ?? configuredModel
          ?? rerankerTarget.kind,
        estimated_memory_bytes: diagnostics?.estimated_peak_bytes,
        last_error: lastError,
      } : null,
    });
    } catch (error) { return mapApiError(c, error); }
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
      const pausedJob = action === 'resume'
        ? (await readCurrentProjectJobs(deps.semanticJobs,
          [{ projectId: id, generationIds: [...currentGenerationIds], pausedOnly: true }], c.req.raw.signal))[0]
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
