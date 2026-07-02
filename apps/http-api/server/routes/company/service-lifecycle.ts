/**
 * Per-service container lifecycle routes.
 *
 * Operates on a SINGLE running service container, not on the broader
 * `/services` CRUD surface (which still lives in `sessions.ts`):
 *   - POST /:sid/pause        runtime-pause (process group, files stay)
 *   - POST /:sid/unpause      counterpart of pause
 *   - GET  /:sid/logs         tail dev-server.log + port readiness probe
 *   - POST /:sid/restart-dev  kill dev-server process + relaunch
 *
 * `rejectIfAttached` is exported because the bigger services CRUD
 * routes still in `sessions.ts` (start/retry) need it too. Once those
 * routes move, this can become file-local again.
 *
 * Phase 8 part 2.2: extracted from `sessions.ts` mega-file.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { ServiceRestartError } from '@mcp/services/sandbox/manager/dev-lifecycle.js';
import { parseIdParam, notFound } from '../_helpers.js';
import { recordOperatorTransition } from './service-transition-log.js';

/**
 * Reject lifecycle calls (start/pause/unpause/restart/retry) on
 * services that reference an externally-managed container. The
 * platform never starts/stops these — only `inspect` is allowed.
 * Returns `null` when the call is permitted.
 */
export function rejectIfAttached(
  deps: ServerDeps,
  id: number,
  serviceId: string,
): { status: 409; error: string } | null {
  const row = deps.companySandboxServicesStore.get(id, serviceId);
  if (row?.is_attached === 1) {
    return {
      status: 409,
      error:
        "This service is an externally-managed container — manage its lifecycle from your host (podman start/stop). Use Refresh to update its status.",
    };
  }
  return null;
}

export function mountCompanyServiceLifecycleRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore } = deps;

  app.post('/api/company/sessions/:id/services/:serviceId/pause', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const blocked = rejectIfAttached(deps, id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);
    try {
      const sb = await getSandboxManager().pauseRuntimeContainer(String(id), serviceId);
      recordOperatorTransition(deps, id, serviceId, 'paused', 'pause route');
      return c.json({
        ok: true,
        service_id: serviceId,
        status: sb.runtimePaused ? 'paused' : sb.status,
        runtime_paused: !!sb.runtimePaused,
        preview_url: sb.previewUrl,
        container_id: sb.containerId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status: 404 | 409 | 500 = /No sandbox|No service|no longer exists/i.test(message)
        ? 404
        : /Cannot|not running/i.test(message)
          ? 409
          : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post('/api/company/sessions/:id/services/:serviceId/unpause', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    const blocked = rejectIfAttached(deps, id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);
    try {
      const sb = await getSandboxManager().unpauseRuntimeContainer(String(id), serviceId);
      recordOperatorTransition(deps, id, serviceId, 'running', 'unpause route');
      return c.json({
        ok: true,
        service_id: serviceId,
        status: sb.runtimePaused ? 'paused' : sb.status,
        runtime_paused: !!sb.runtimePaused,
        preview_url: sb.previewUrl,
        container_id: sb.containerId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status: 404 | 409 | 500 = /No sandbox|No service|no longer exists/i.test(message)
        ? 404
        : /Cannot|not running/i.test(message)
          ? 409
          : 500;
      return c.json({ error: message }, status);
    }
  });

  /**
   * Tail the dev-server log inside a running sandbox container.
   * Convenience endpoint for debugging "why isn't my preview
   * working?" — the scaffolder redirects `npm run dev` stdout+stderr
   * to `/tmp/dev-server.log` inside the container; this exposes the
   * last N lines so operators can see Vite's own output (compile
   * errors, port-bind failures, etc) without shelling into podman.
   *
   * Query: `?lines=200` (default 200, max 2000)
   */
  app.get('/api/company/sessions/:id/services/:serviceId/logs', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const svc = getSandboxManager().getService(String(id), serviceId);
    if (!svc || !svc.containerId) {
      return c.json({ error: `service '${serviceId}' not running` }, 404);
    }
    if (svc.runtimePaused) {
      return c.json({ error: `service '${serviceId}' is runtime-paused` }, 409);
    }
    const requested = Number(c.req.query('lines') ?? '200');
    const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 10), 2_000) : 200;
    const { resolveDriver } = await import('@mcp/services/sandbox/index.js');
    const driver = await resolveDriver();
    if (svc.imageSource === 'project_dockerfile') {
      const logs = await driver.getContainerLogs(svc.containerId, lines).catch(() => '');
      return c.json({
        devServer: logs,
        containerId: svc.containerId,
        hostPort: svc.hostPort,
        portStatus: (await driver.isPortListening(svc.hostPort)) ? 'listening' : 'not-listening',
        scaffolder: svc.recentLogs,
      });
    }
    const res = await driver.exec(
      svc.containerId,
      `tail -n ${lines} /tmp/dev-server.log 2>/dev/null || true`,
      { cwd: undefined, timeoutMs: 5_000 },
    );
    const portProbe = await driver.exec(
      svc.containerId,
      `ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':${svc.containerPort}$' >/dev/null && echo listening || echo not-listening`,
      { cwd: undefined, timeoutMs: 2_000 },
    );
    return c.json({
      devServer: res.stdout,
      containerId: svc.containerId,
      hostPort: svc.hostPort,
      portStatus: portProbe.stdout.trim(),
      scaffolder: svc.recentLogs,
    });
  });

  // Restart dev-server inside a service container — kills the node/
  // wrangler process and relaunches. Used when the dev server died but
  // the container stayed. Delegates to `SandboxManager.restartService`
  // (B2) so the kill+relaunch synthesis lives in ONE place — the manager
  // reuses the scaffolder/external-node relaunch paths instead of the
  // hardcoded command this route used to synthesize inline.
  app.post('/api/company/sessions/:id/services/:serviceId/restart-dev', async (c) => {
    const id = parseIdParam(c);
    const serviceId = c.req.param('serviceId');
    if (!serviceId) return c.json({ error: 'serviceId required' }, 400);
    const blocked = rejectIfAttached(deps, id, serviceId);
    if (blocked) return c.json({ error: blocked.error }, blocked.status);
    try {
      await getSandboxManager().restartService(String(id), serviceId);
      recordOperatorTransition(deps, id, serviceId, 'restarted', 'restart-dev route');
      return c.json({ ok: true });
    } catch (e) {
      if (e instanceof ServiceRestartError) {
        return c.json({ error: e.message }, e.code === 'not_running' ? 404 : 409);
      }
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: `failed to relaunch dev-server: ${message}` }, 500);
    }
  });
}
