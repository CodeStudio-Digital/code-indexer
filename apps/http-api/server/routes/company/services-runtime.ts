/**
 * Runtime operations on a single existing microservice:
 *   - POST   /:id/services/:sid/start     boot the container (primary or secondary)
 *   - POST   /:id/services/:sid/refresh   re-probe an attached external container
 *   - POST   /:id/services/:sid/retry     re-provision after error / orphan
 *   - DELETE /:id/services/:sid           full teardown (container + project + workdir)
 *
 * Extracted from `services.ts` to keep the file under the LOC cap. Pause /
 * unpause / logs / restart-dev live in `service-lifecycle.ts` (the
 * lower-level routes that don't need to know about retry semantics).
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import type { BuilderStack } from '@mcp/services/sandbox/types.js';
import { rejectIfAttached as rejectIfAttachedShared } from './service-lifecycle.js';
import { resolveExternalProjectSpec } from './sandbox-helpers.js';
import {
  removeServiceAndProject,
  serviceStartPayload,
  startPrimarySandboxForSession,
} from './service-helpers.js';
import { recordOperatorTransition } from './service-transition-log.js';

export function mountCompanyServicesRuntimeRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db } = deps;

  function rejectIfAttached(
    id: number,
    serviceId: string,
  ): { status: 409; error: string } | null {
    return rejectIfAttachedShared(deps, id, serviceId);
  }

  // ─── Start a service container (primary or secondary) ───────────

  app.post('/api/company/sessions/:id/services/:serviceId/start', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const blocked = rejectIfAttached(id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);

    if (serviceId === 'main') {
      const result = await startPrimarySandboxForSession(deps, id, false);
      if (!result.ok) return c.json({ error: result.error }, result.status);
      recordOperatorTransition(deps, id, 'main', 'running', 'start route');
      return c.json(serviceStartPayload('main', result.sandbox));
    }

    const manager = getSandboxManager();
    await manager.reconcileServiceFromDb(String(id), serviceId).catch(() => void 0);
    const live = manager.getService(String(id), serviceId);
    if (live && live.status !== 'error') {
      try {
        const sb = live.runtimePaused
          ? await manager.unpauseRuntimeContainer(String(id), serviceId)
          : live.status === 'paused'
            ? await manager.startServiceContainer(String(id), serviceId)
            : live;
        recordOperatorTransition(deps, id, serviceId, 'running', 'start route');
        return c.json(serviceStartPayload(serviceId, sb));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!/no longer exists/i.test(message)) {
          return c.json({ error: message }, 409);
        }
        // Fall through to recreate from the saved row/project below.
      }
    }

    interface StartBody {
      stack?: string;
      name?: string;
      limits?: { memory?: string; cpus?: string; pids?: number };
    }
    const body = await parseJsonBody<StartBody>(c).catch(() => null);
    const row = deps.companySandboxServicesStore.get(id, serviceId);

    let resolvedStack: string;
    let resolvedName: string;
    let limits: { memory?: string; cpus?: string; pids?: number } = {};
    let hostWorkdirMount: string | undefined;
    let provisionSpec:
      | ReturnType<typeof resolveExternalProjectSpec>
      | {};
    let forceRecreate = live?.status === 'error';

    if (row) {
      resolvedStack = row.stack;
      resolvedName = row.name || row.service_id;
      try {
        limits = JSON.parse(row.limits_json) as typeof limits;
      } catch { /* ignore malformed limits */ }
      hostWorkdirMount = row.host_workdir_mount || undefined;
      try {
        const link = companyStore
          .listCompanySessionProjects(id)
          .find((p) => p.label === row.service_id);
        if (link) {
          const proj = db.getProject(link.project_id);
          if (proj?.root_path) hostWorkdirMount = proj.root_path;
        }
      } catch { /* fall back to row.host_workdir_mount */ }
      if (row.mount_kind === 'external') {
        try {
          if (row.image_source === 'project_dockerfile') {
            if (!row.dockerfile_path || !row.dockerfile_exposed_port) {
              throw new Error(
                'External Dockerfile service is missing Dockerfile metadata. Re-add it from the External project tab.',
              );
            }
            provisionSpec = {
              mountKind: 'external',
              imageSource: 'project_dockerfile',
              dockerfilePath: row.dockerfile_path,
              containerPortOverride: row.dockerfile_exposed_port,
              skipDefaultCommand: true,
            };
          } else if (hostWorkdirMount) {
            provisionSpec = resolveExternalProjectSpec(
              hostWorkdirMount,
              row.stack as BuilderStack,
              'node',
            );
          } else {
            throw new Error('External Node service is missing its project root.');
          }
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      } else {
        provisionSpec = {};
      }
    } else {
      const link = companyStore
        .listCompanySessionProjects(id)
        .find((p) => p.label === serviceId);
      if (!link) {
        return c.json({ error: `Service '${serviceId}' not found` }, 404);
      }
      const stack = body?.stack?.trim();
      if (!stack) {
        return c.json(
          {
            error:
              `Service '${serviceId}' has no saved stack. Pass { "stack": "<react-ts|vue-ts|vite-api|cf-worker|...>" } to start it.`,
          },
          400,
        );
      }
      const proj = db.getProject(link.project_id);
      resolvedStack = stack;
      resolvedName = body?.name ?? proj?.name ?? serviceId;
      if (body?.limits) limits = body.limits;
      hostWorkdirMount = proj?.root_path ?? undefined;
      if (proj && !proj.name.startsWith('_builder_')) {
        try {
          provisionSpec = resolveExternalProjectSpec(proj.root_path, stack as BuilderStack);
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      } else {
        provisionSpec = {};
      }
    }

    try {
      const sandbox = await manager.provisionAdditionalService({
        sessionId: String(id),
        serviceId,
        stack: resolvedStack as BuilderStack,
        name: resolvedName,
        limits,
        hostWorkdirMount,
        forceRecreate,
        ...provisionSpec,
      });
      recordOperatorTransition(deps, id, serviceId, 'running', 'start route (provision)');
      return c.json(serviceStartPayload(serviceId, sandbox));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // ─── Re-probe an attached external service ──────────────────────

  app.post('/api/company/sessions/:id/services/:serviceId/refresh', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const row = deps.companySandboxServicesStore.get(id, serviceId);
    if (!row || row.is_attached !== 1) {
      return c.json(
        { error: 'Refresh is only available for attached external containers.' },
        409,
      );
    }
    try {
      const sandbox = await getSandboxManager().refreshAttachedService(String(id), serviceId);
      return c.json({
        service_id: serviceId,
        container_id: sandbox.containerId,
        hostname: sandbox.attachedHostname ?? serviceId,
        status: sandbox.runtimePaused ? 'paused' : sandbox.status,
        runtime_paused: !!sandbox.runtimePaused,
        error: sandbox.error ?? null,
        last_checked_at: sandbox.lastAccessAt,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message }, 500);
    }
  });

  // ─── Retry a failed / orphaned service ──────────────────────────

  app.post('/api/company/sessions/:id/services/:serviceId/retry', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const blocked = rejectIfAttached(id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);

    // Retry re-provisions the service using the saved row — same
    // stack / limits / host workdir mount. Two recoverable states:
    //   1. Row exists (active, `error`, or soft-deleted `destroyed`
    //      from a transient teardown) → infer everything from it.
    //   2. Row is gone AND a project link with `label=serviceId`
    //      exists in `company_session_projects` → historical orphan
    //      (session 68 pattern). The UI sends `{ stack }` in the
    //      body so we can provision from scratch pointing at the
    //      pre-existing `root_path`. Files on disk are preserved;
    //      the scaffolder skips when `hasInitializedWorkdir` hits.
    const row = deps.companySandboxServicesStore.get(id, serviceId);
    interface RetryBody {
      stack?: string;
      name?: string;
      limits?: { memory?: string; cpus?: string; pids?: number };
    }
    const body = await parseJsonBody<RetryBody>(c).catch(() => null);

    let resolvedStack: string;
    let resolvedName: string;
    let limits: { memory?: string; cpus?: string; pids?: number } = {};
    let hostWorkdirMount: string | undefined;
    let forceRecreate: boolean;
    let provisionSpec:
      | ReturnType<typeof resolveExternalProjectSpec>
      | {};

    if (row) {
      resolvedStack = row.stack;
      resolvedName = row.name || row.service_id;
      try {
        limits = JSON.parse(row.limits_json) as typeof limits;
      } catch { /* ignore malformed limits */ }
      // Authoritative workdir: the UUID-based `root_path` of the
      // `projects` row the POST endpoint created for this service. Do
      // NOT trust `row.host_workdir_mount` — when an earlier provision
      // failed before reaching the post-create persist, that column
      // stays null and the manager falls back to the serviceId-based
      // legacy layout (`data/virtual-projects/<serviceId>`), which is
      // NOT the same path the scaffolder seeded / the agents have been
      // writing to.
      hostWorkdirMount = row.host_workdir_mount || undefined;
      try {
        const link = companyStore
          .listCompanySessionProjects(id)
          .find((p) => p.label === row.service_id);
        if (link) {
          const proj = db.getProject(link.project_id);
          if (proj?.root_path) hostWorkdirMount = proj.root_path;
        }
      } catch { /* fall back to row.host_workdir_mount */ }
      // Row present → manager still owns an in-memory Sandbox (even
      // a destroyed one from the same process); forceRecreate lets
      // the path tear it down and rebuild cleanly.
      forceRecreate = true;
      if (row.mount_kind === 'external') {
        try {
          if (row.image_source === 'project_dockerfile') {
            const dockerfilePath = row.dockerfile_path;
            const port = row.dockerfile_exposed_port;
            if (!dockerfilePath || !port) {
              throw new Error(
                'External Dockerfile service is missing Dockerfile metadata. Re-add it from the External project tab.',
              );
            }
            provisionSpec = {
              mountKind: 'external',
              imageSource: 'project_dockerfile',
              dockerfilePath,
              containerPortOverride: port,
              skipDefaultCommand: true,
            };
          } else if (hostWorkdirMount) {
            provisionSpec = resolveExternalProjectSpec(
              hostWorkdirMount,
              row.stack as BuilderStack,
              'node',
            );
          } else {
            throw new Error('External Node service is missing its project root.');
          }
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      } else {
        provisionSpec = {};
      }
    } else {
      // Historical orphan: no row, but a project link may exist.
      const link = companyStore
        .listCompanySessionProjects(id)
        .find((p) => p.label === serviceId);
      if (!link) {
        return c.json({ error: `Service '${serviceId}' not found` }, 404);
      }
      const stack = body?.stack?.trim();
      if (!stack) {
        return c.json(
          {
            error:
              `Service '${serviceId}' has no saved stack (orphaned project). ` +
              `Pass { "stack": "<react-ts|vue-ts|vite-api|cf-worker|…>" } in the retry body.`,
          },
          400,
        );
      }
      resolvedStack = stack;
      const proj = db.getProject(link.project_id);
      resolvedName = body?.name ?? proj?.name ?? serviceId;
      if (body?.limits) limits = body.limits;
      hostWorkdirMount = proj?.root_path ?? undefined;
      forceRecreate = false;
      if (proj && !proj.name.startsWith('_builder_')) {
        try {
          provisionSpec = resolveExternalProjectSpec(proj.root_path, stack as BuilderStack);
        } catch (e) {
          return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      } else {
        provisionSpec = {};
      }
    }

    try {
      const sandbox = await getSandboxManager().provisionAdditionalService({
        sessionId: String(id),
        serviceId,
        stack: resolvedStack as BuilderStack,
        name: resolvedName,
        limits,
        hostWorkdirMount,
        forceRecreate,
        ...provisionSpec,
      });
      recordOperatorTransition(deps, id, serviceId, 'running', 'retry route');
      return c.json({
        service_id: serviceId,
        preview_url: sandbox.previewUrl,
        container_id: sandbox.containerId,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  // ─── Delete a service (container + project + workdir) ───────────

  app.delete('/api/company/sessions/:id/services/:serviceId', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    try {
      await removeServiceAndProject(deps, id, serviceId);
    } catch (e) {
      // B3 item 6 — `SandboxService.removeService` now surfaces a failed
      // container destroy instead of silently dropping the binding.
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
    return c.json({ ok: true });
  });
}
