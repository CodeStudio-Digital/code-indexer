/**
 * Sandbox lifecycle routes — the dashboard's BuilderView / PreviewSidebar
 * talks to these to provision, poll, restart, and tail the primary
 * sandbox of a company session.
 *
 *   - POST   /:id/sandbox               provision (idempotent; ?retry=1 forces)
 *   - POST   /:id/sandbox/restart-dev   relaunch the dev server in place
 *   - GET    /:id/sandbox/logs          tail /tmp/dev-server.log + scaffolder ring buffer
 *   - GET    /:id/sandbox               status poll + preview cookie mint
 *
 * Phase 8 part 2 (continuation): extracted from `sessions.ts` so the
 * mega-file can shrink to session CRUD only. The "additional service
 * start" path lives in `services.ts` even though the URL says
 * `/services/:sid/start` — keeping it next to the rest of the services
 * CRUD makes the lifecycle (start → refresh → retry → delete) easier to
 * follow.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { parseIdParam, notFound } from '../_helpers.js';
import { getSandboxManager, resolveDriver } from '@mcp/services/sandbox/index.js';
import type {
  BuilderStack,
  ProvisionableStack,
} from '@mcp/services/sandbox/types.js';
import { defaultLocalShellPort } from '@mcp/code-agent/ports/shell-port.js';
import { imagesArgs, parseImages } from '@mcp/podman-core';
import {
  isProvisionableStack,
  resolveExternalProjectSpec,
  type ExternalProjectRuntime,
} from './sandbox-helpers.js';

export function mountCompanySandboxRoutes(app: Hono, deps: ServerDeps): void {
  const { companyStore, db } = deps;

  /**
   * Eagerly provision the builder sandbox for a session. Called by the
   * BuilderView the moment it renders so the container is already
   * scaffolding while the user is still typing their first prompt.
   *
   * Idempotent: a second POST while the sandbox is already
   * provisioning/ready returns the current snapshot without spawning
   * a second container (SandboxManager.provision short-circuits on an
   * existing entry).
   *
   * Returns 409 for sessions that weren't created with `builder.stack`
   * — we never silently upgrade a traditional session into builder mode.
   */
  app.post('/api/company/sessions/:id/sandbox', async (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);

    let stack: ProvisionableStack | null = null;
    // Extract limits alongside stack in a single JSON parse. Without
    // this, the eager-provision endpoint creates the container with
    // process defaults (1g/1/256), and the later idempotent call from
    // `SandboxService.provisionIfNeeded` — which DOES pass limits —
    // short-circuits on the existing sandbox. Net result: user-chosen
    // limits silently ignored.
    let limits: { memory?: string; cpus?: string; pids?: number } | undefined;
    // Per-session image + run flags chosen in the company builder UI. Threaded
    // into provision so the eager-provision path matches what SandboxService
    // later requests (otherwise the idempotent short-circuit would drop them).
    let image: string | undefined;
    let runArgs: string[] | undefined;
    try {
      const cfg = JSON.parse(session.config_json || '{}') as {
        builder?: {
          stack?: string;
          limits?: { memory?: string; cpus?: string; pids?: number };
          main_project_id?: number;
          main_project_runtime?: ExternalProjectRuntime;
          image?: string;
          runArgs?: string[];
        };
      };
      const requested = cfg.builder?.stack;
      // `isProvisionableStack` (vs `isBuilderStack`) — DS sessions use
      // `'node-only'` which is registered as a scaffolder but kept out
      // of the user-facing builder picker. The provision route must
      // accept it so DS sessions can have their container restarted.
      if (isProvisionableStack(requested)) stack = requested;
      if (cfg.builder?.limits) limits = cfg.builder.limits;
      if (cfg.builder?.image) image = cfg.builder.image;
      if (Array.isArray(cfg.builder?.runArgs)) runArgs = cfg.builder.runArgs;
    } catch {
      /* treat as non-builder */
    }
    if (!stack) {
      return c.json({ error: 'session was not created with builder mode' }, 409);
    }

    // `?retry=1` (or JSON body `{retry:true}`) forces teardown of an
    // existing errored sandbox before provisioning. The UI's retry
    // button sets this; the normal eager-provision call from the hook
    // omits it so the idempotent fast-path still applies.
    const retry =
      c.req.query('retry') === '1' ||
      (await c.req.json().catch(() => ({}) as { retry?: boolean })).retry === true;

    const manager = getSandboxManager();
    const cfg = JSON.parse(session.config_json || '{}') as {
      builder?: { main_project_id?: number; main_project_runtime?: ExternalProjectRuntime };
    };
    const mainProjectId = cfg.builder?.main_project_id;
    const linkedProjects = companyStore.listCompanySessionProjects(id);
    const primaryLink =
      mainProjectId != null
        ? linkedProjects.find((p) => p.project_id === mainProjectId)
        : linkedProjects.find((p) => !p.label) ?? linkedProjects[0];
    const primaryProject = primaryLink ? db.getProject(primaryLink.project_id) : null;
    const hostWorkdirMount = primaryProject?.root_path ?? undefined;
    let externalSpec:
      | ReturnType<typeof resolveExternalProjectSpec>
      | {};
    if (mainProjectId != null) {
      if (!primaryProject) return c.json({ error: `Project ${mainProjectId} not found` }, 404);
      try {
        externalSpec = resolveExternalProjectSpec(
          primaryProject.root_path,
          stack as BuilderStack,
          cfg.builder?.main_project_runtime,
        );
      } catch (e) {
        return c.json(
          { error: e instanceof Error ? e.message : String(e) },
          400,
        );
      }
    } else {
      externalSpec = {};
    }
    try {
      const sandbox = await manager.provision({
        sessionId: String(id),
        stack,
        retry,
        limits,
        hostWorkdirMount,
        image,
        runArgs,
        ...externalSpec,
      });
      return c.json({
        status: sandbox.status,
        step: sandbox.step,
        previewUrl: sandbox.previewUrl,
        stack: sandbox.stack,
        hostPort: sandbox.hostPort,
      });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  /**
   * Host image catalog — lists the local OCI images so the builder UI can
   * offer a base-image picker. Reuses the SAME @mcp/podman-core parser the IDE
   * Podman plugin uses, so both surfaces show identical rows. Runtime-agnostic:
   * runs whichever binary the driver factory resolved (podman/docker).
   */
  app.get('/api/company/sandbox/images', async (c) => {
    const driver = await resolveDriver();
    if (driver.runtime === 'e2b') return c.json({ runtime: 'e2b', images: [] });
    try {
      const r = await defaultLocalShellPort().run(driver.runtime, imagesArgs(), {
        cwd: process.cwd(),
        encoding: 'utf-8',
      });
      if (r.exitCode !== 0) {
        return c.json({ error: r.stderr.trim() || `${driver.runtime} images failed` }, 500);
      }
      return c.json({ runtime: driver.runtime, images: parseImages(r.stdout) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  /**
   * Kill and relaunch the dev server inside a running sandbox WITHOUT
   * destroying the container. Used by the PreviewPanel's "Restart
   * dev-server" button when the iframe shows ECONNREFUSED but the
   * container is still alive (typical cause: agent overwrote
   * `vite.config.ts` with a default template and lost `server.host`
   * / `usePolling` / `base`).
   *
   * Preserves: container, installed node_modules, user-written source,
   * host port.
   * Resets: vite.config.ts (to the canonical proxy-aware template),
   * running Vite process.
   */
  app.post('/api/company/sessions/:id/sandbox/restart-dev', async (c) => {
    const id = parseIdParam(c);
    const sandbox = getSandboxManager().get(String(id));
    if (!sandbox) return c.json({ error: 'sandbox not running' }, 404);
    try {
      await getSandboxManager().restartDevServer(String(id));
      return c.json({ ok: true, previewUrl: sandbox.previewUrl });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : String(e) },
        500,
      );
    }
  });

  app.get('/api/company/sessions/:id/sandbox/logs', async (c) => {
    const id = parseIdParam(c);
    const sandbox = getSandboxManager().get(String(id));
    if (!sandbox || !sandbox.containerId) {
      return c.json({ error: 'sandbox not running' }, 404);
    }
    // Watching the dev-server log counts as activity too.
    getSandboxManager().touch(String(id));
    const requested = Number(c.req.query('lines') ?? '200');
    const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 10), 2_000) : 200;
    // Best-effort: if the file doesn't exist yet (dev-server still
    // spinning up) we return an empty string rather than a 500.
    const { resolveDriver } = await import('@mcp/services/sandbox/index.js');
    const driver = await resolveDriver();
    const res = await driver.exec(
      sandbox.containerId,
      `tail -n ${lines} /tmp/dev-server.log 2>/dev/null || true`,
      { cwd: undefined, timeoutMs: 5_000 },
    );
    return c.json({
      devServer: res.stdout,
      containerId: sandbox.containerId,
      hostPort: sandbox.hostPort,
      // The `recentLogs` ring buffer also carries scaffolder-level
      // lines. Surface them alongside so the UI has everything on
      // one request.
      scaffolder: sandbox.recentLogs,
    });
  });

  /**
   * Builder-mode status poll. Returns the sandbox state (if any) plus
   * the persisted `builder.stack` selection so the dashboard knows
   * whether to render the BuilderView or the traditional layout.
   *
   * Designed for lightweight polling: the payload is tiny and the
   * handler reads purely from in-memory state (no DB hit beyond the
   * initial session lookup).
   */
  app.get('/api/company/sessions/:id/sandbox', (c) => {
    const id = parseIdParam(c);
    const session = companyStore.getCompanySession(id);
    if (!session) return notFound(c);
    let stack: ProvisionableStack | null = null;
    let studio = false;
    try {
      const cfg = JSON.parse(session.config_json || '{}') as {
        builder?: { stack?: string; studio?: boolean };
      };
      const requested = cfg.builder?.stack;
      if (isProvisionableStack(requested)) stack = requested;
      studio = !!cfg.builder?.studio;
    } catch {
      // Legacy sessions have arbitrary config_json — treat as non-builder.
    }
    const sandbox = getSandboxManager().get(String(id));
    // Treat an active poll from the dashboard as "the user is watching
    // this session" — bump the idle timer so the reaper doesn't kill
    // a live-but-silent sandbox out from under an open browser tab.
    // Without this, sandboxes died after 30 min even with the preview
    // iframe visible, because HMR is all-WebSocket after the initial
    // load and the WS upgrade only touches once.
    if (sandbox) getSandboxManager().touch(String(id));

    // Mint a rolling preview cookie whenever the session polls status.
    // The browser refreshes it every ~1s while provisioning and every
    // ~10s once ready, so the sliding 30-min TTL is in practice always
    // fresh for an active user — idle tabs naturally lose access.
    const response = c.json({
      builder: stack ? { stack, studio } : null,
      sandbox: sandbox
        ? {
            status: sandbox.status,
            runtimePaused: !!sandbox.runtimePaused,
            step: sandbox.step,
            previewUrl: sandbox.previewUrl,
            stack: sandbox.stack,
            error: sandbox.error ?? null,
            hostPort: sandbox.hostPort,
            createdAt: sandbox.createdAt,
            // Tail of the ring buffer so the preview pane can show a
            // live log without opening a second stream. Cap at 50 lines
            // here (the manager keeps up to 200) to keep each poll
            // response small even during a noisy npm install.
            recentLogs: sandbox.recentLogs.slice(-50),
            // Exposed solely so the "View dev-server logs" button in
            // the UI knows whether a container is live enough to
            // have a log to tail. Not sensitive — it's a random sha256.
            containerId: sandbox.containerId || undefined,
            // Resolved limits the container was actually created with
            // (session override merged with env defaults). UI displays
            // this so users know "am I on 512m or 2g?" at a glance.
            limits: sandbox.limits,
          }
        : null,
    });
    // Phase C: the dashboard preview now points at the sandbox's direct
    // loopback URL (http://127.0.0.1:<hostPort>/), so the HMAC cookie
    // the proxy used to verify is no longer minted here. Sibling-
    // container access (Chrome Service for QA) still uses the
    // longer-lived MCP_PREVIEW_COOKIE injected by syncManagedEnvs.
    return response;
  });
}
