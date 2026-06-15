/**
 * SandboxService — bridges a company session to an ephemeral sandbox
 * container, enabling the builder ("v0-style") flow without touching
 * any existing service.
 *
 * Responsibilities:
 *   - On master start (only when `builder.stack` is set in the session
 *     config), provision a sandbox via `SandboxManager` and remember the
 *     resulting `SandboxBinding` for this session.
 *   - Forward all `SandboxManager` events for this sandbox through the
 *     company `metaBus` as `sandbox.*` messages so the dashboard can
 *     render provisioning progress and the preview URL.
 *   - On session end/abort/destroy, tear the sandbox down.
 *
 * The service follows the same shape as the other 8 services in this
 * folder: constructor wires `SessionContext` + `MetaBusPublisher`, public
 * methods are driven by the orchestrator and by the `MasterLifecycle`
 * start hook.
 *
 * When `builder` is NOT configured, `provisionIfNeeded()` is a no-op and
 * `getBinding()` returns `null` — the service adds zero overhead to the
 * traditional (non-builder) company session path.
 */

import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { MetaBusPublisher } from '@mcp/company/services/MetaBusPublisher.js';
import type { BuilderServiceConfig, SandboxBinding } from '@mcp/company/types.js';
import type {
  Sandbox,
  SandboxEvent,
  SandboxStack,
} from '@mcp/services/sandbox/index.js';
import { getSandboxManager, resolveDriver } from '@mcp/services/sandbox/index.js';
import { detectDockerfile } from '@mcp/services/sandbox/dockerfile-detector.js';
import { detectManifest } from '@mcp/services/sandbox/manifest-detector/detect.js';
import type { NodeManifest } from '@mcp/services/sandbox/manifest-detector/types.js';
// Archive persistence is now owned by SandboxManager itself (auto-save
// on destroy, auto-load on provision). We re-export the path helper so
// the DELETE /sessions handler — which doesn't go through the manager
// for cleanup — can still resolve the file to delete.
import { archivePath } from '@mcp/services/sandbox/archive.js';
import { tryGetChromeService } from '@mcp/services/chrome-service/chrome-service.js';
import type { SandboxManager } from '@mcp/services/sandbox/sandbox-manager.js';

/** @deprecated prefer `archivePath` from `core/sandbox/archive`. Re-exported
 *  for back-compat with the DELETE /sessions handler. */
export function sandboxArchivePath(sessionId: string | number): string {
  return archivePath(sessionId);
}

/**
 * Pure: return `true` when at least one entry in the session config's
 * `role_assignments` carries the `qa-playwright` skill. Used by
 * `provisionIfNeeded` to flip `ProvisionRequest.includeE2e`, which in
 * turn picks the Chromium-capable image and triggers the Playwright
 * Agent CLI bootstrap inside the scaffolder.
 *
 * Tolerant of every malformed input shape. Exported for unit testing
 * without a store / DB.
 */
export function hasQaPlaywrightSkill(configJson: string): boolean {
  if (!configJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const roles = (parsed as { role_assignments?: unknown }).role_assignments;
  if (!Array.isArray(roles)) return false;
  for (const role of roles) {
    if (!role || typeof role !== 'object') continue;
    const skills = (role as { skills?: unknown }).skills;
    if (!Array.isArray(skills)) continue;
    if (skills.some((s) => typeof s === 'string' && s === 'qa-playwright')) {
      return true;
    }
  }
  return false;
}

function inferExternalNodePort(stack: SandboxStack, manifest: NodeManifest): number {
  const scriptName = manifest.devScriptName;
  const script = scriptName ? manifest.scripts[scriptName]?.toLowerCase() ?? '' : '';
  if (stack === 'angular' || /\bng\s+serve\b/.test(script)) return 4200;
  if (/\bnext\s+(dev|start)\b/.test(script)) return 3000;
  return 5173;
}

/**
 * Wire a session to the SHARED Chrome Service singleton (v4.0).
 *
 * - When the service is enabled and running: persist
 *   `PLAYWRIGHT_WS_ENDPOINT` (auto-source) into the session's env
 *   store and trigger a `.env` sync on any live container so the
 *   value is available to `npx playwright test` immediately.
 * - When the service is absent / disabled / errored: log a warning
 *   and continue. The QA agent will surface a clear diagnosis via
 *   `qa_get_browser_endpoint`.
 *
 * Best-effort throughout: never throws to the provision path.
 */
async function wireSessionToChromeService(
  companySessionId: number,
  manager: SandboxManager,
): Promise<void> {
  const svc = tryGetChromeService();
  if (!svc) {
    console.warn(
      `[sandbox-service] chrome service singleton not wired — session ${companySessionId} will not have PLAYWRIGHT_WS_ENDPOINT`,
    );
    return;
  }
  const state = await svc.getEndpoint();
  if (state.status !== 'running') {
    console.log(
      `[sandbox-service] chrome service status=${state.status} — session ${companySessionId} provisions without PLAYWRIGHT_WS_ENDPOINT (operator must enable in Admin)`,
    );
    return;
  }
  // Write the endpoint directly so brand-new sessions (not yet seen by
  // the backfill loop in `ChromeService.enable`) get it before the
  // first .env sync. The auto source means env_set tools won't
  // surface this row as user-editable.
  const envStore = getCompanySessionEnvStore();
  if (envStore) {
    try {
      envStore.upsert(companySessionId, 'PLAYWRIGHT_WS_ENDPOINT', state.wsEndpoint, false, {
        source: 'auto',
      });
    } catch (e) {
      console.warn(
        `[sandbox-service] env upsert ${companySessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // Push to live containers so .env is up-to-date.
  await manager.syncEnvsToAllContainers(String(companySessionId));
}

// Module-level binding for the env store, wired at boot from server.ts
// (mirrors the pattern in env-tools.ts and sandbox-manager.ts).
let companySessionEnvStoreRef: import('@mcp/store/company-session-env-store.js').CompanySessionEnvStore | null = null;
export function setSandboxServiceEnvStore(
  store: import('@mcp/store/company-session-env-store.js').CompanySessionEnvStore | null,
): void {
  companySessionEnvStoreRef = store;
}
function getCompanySessionEnvStore() {
  return companySessionEnvStoreRef;
}

/**
 * Shape we expect inside `CompanySession.config_json` when builder is on.
 *
 * Two forms are supported:
 *   - Legacy single-service: `{ builder: { stack, limits? } }` — implicit
 *     service_id "main", kept for back-compat with sessions created
 *     before migration 035.
 *   - Multi-service: `{ builder: { services: BuilderServiceConfig[] } }`
 *     — each entry becomes its own container sharing the session's
 *     docker network. Exactly one entry may have `primary: true`; if
 *     none is marked, the first entry is promoted.
 */
export interface BuilderSessionConfig {
  builder?: {
    stack?: SandboxStack;
    /** Optional per-session CPU/memory/pids override. See SandboxLimits. */
    limits?: {
      memory?: string;
      cpus?: string;
      pids?: number;
    };
    main_project_id?: number;
    main_project_runtime?: 'dockerfile' | 'node';
    /** Per-session base image override (from the company image picker). */
    image?: string;
    /** Extra raw `podman/docker run` flags for this session. */
    runArgs?: string[];
    /** Multi-microservice form; when present, overrides `stack`/`limits` above. */
    services?: BuilderServiceConfig[];
  };
}

export class SandboxService {
  private binding: SandboxBinding | null = null;
  /**
   * In-flight provision promise. A cold container build can take minutes;
   * without this guard a duplicate resume (or a sub-session sharing the
   * parent's binding) would each call `manager.provision`, racing on the
   * same sandboxId. Concurrent callers share this one promise; cleared in
   * its `finally` so a later provision (after teardown) starts fresh.
   */
  private provisioning: Promise<SandboxBinding | null> | null = null;
  /**
   * Secondary-service bindings keyed by serviceId. The primary sandbox
   * keeps flowing through `binding` for back-compat with the existing
   * runCoder plumbing; additional microservices live here and are
   * surfaced via `getServiceBinding()` for tools that explicitly
   * target a service.
   */
  private readonly serviceBindings = new Map<string, SandboxBinding>();
  private unsubscribe: (() => void) | null = null;
  /** Tracks our sandboxId so we ignore events for other concurrent sessions. */
  private readonly sessionKey: string;

  constructor(
    private readonly ctx: SessionContext,
    private readonly publisher: MetaBusPublisher,
  ) {
    this.sessionKey = String(ctx.companySessionId);
  }

  /** @returns the current sandbox binding, or `null` when the session isn't in builder mode. */
  getBinding(): SandboxBinding | null {
    return this.binding;
  }

  /** @returns the binding for a secondary service, or `null` when absent. */
  getServiceBinding(serviceId: string): SandboxBinding | null {
    return this.serviceBindings.get(serviceId) ?? null;
  }

  /** @returns every service binding currently alive for this session. */
  listServiceBindings(): Array<{ serviceId: string; binding: SandboxBinding }> {
    return [...this.serviceBindings.entries()].map(([serviceId, binding]) => ({
      serviceId,
      binding,
    }));
  }

  /**
   * Read the stack preference from `CompanySession.config_json`. Returns
   * `null` when builder mode is disabled for this session.
   */
  getRequestedStack(): SandboxStack | null {
    return this.readBuilderConfig()?.stack ?? null;
  }

  /**
   * Stack for a specific serviceId, or the primary/legacy stack when no
   * serviceId is given (or no matching service is found). Used by the
   * prompt builders to render accurate BUILDER-MODE guidance per
   * subordinate — hardcoding `'react-ts'` there produced wrong
   * conventions for Angular/Vue/backend containers.
   */
  getStackForService(serviceId?: string | null): SandboxStack | null {
    const cfg = this.readBuilderConfig();
    if (!cfg) return null;
    if (serviceId && cfg.services?.length) {
      const svc = cfg.services.find((s) => s.serviceId === serviceId);
      if (svc?.stack) return svc.stack as SandboxStack;
    }
    if (cfg.services?.length) {
      const primary = cfg.services.find((s) => s.primary) ?? cfg.services[0]!;
      return (primary.stack as SandboxStack) ?? cfg.stack ?? null;
    }
    return cfg.stack ?? null;
  }

  /**
   * Read both stack + limits from `CompanySession.config_json`. Returns
   * `null` when builder mode is disabled for this session.
   */
  private readBuilderConfig(): BuilderSessionConfig['builder'] | null {
    const row = this.ctx.companyStore.getCompanySession(this.ctx.companySessionId);
    if (!row) return null;
    try {
      const cfg = JSON.parse(row.config_json || '{}') as BuilderSessionConfig;
      return cfg.builder ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Decide whether the session needs the E2E-capable sandbox image
   * (Chromium + GTK libs). True when at least one role assignment in
   * the session config carries the `qa-playwright` skill.
   *
   * Defensive parsing: malformed JSON, missing fields and unexpected
   * types all degrade silently to `false` — sessions without QA stay
   * on the lean image.
   */
  private detectIncludeE2e(): boolean {
    const row = this.ctx.companyStore.getCompanySession(this.ctx.companySessionId);
    if (!row) return false;
    return hasQaPlaywrightSkill(row.config_json ?? '');
  }

  /**
   * Provision (or reuse) the sandbox for this session. Idempotent: a
   * second call with an existing binding returns the same handle.
   *
   * Call this from `MasterLifecycle.start` before the master's runCoder
   * invocation so the returned binding can be woven into its CompanyContext.
   */
  async provisionIfNeeded(opts: { signal?: AbortSignal } = {}): Promise<SandboxBinding | null> {
    if (this.binding) return this.binding;
    if (this.provisioning) return this.provisioning;
    this.provisioning = this.doProvision(opts).finally(() => {
      this.provisioning = null;
    });
    return this.provisioning;
  }

  private async doProvision(opts: { signal?: AbortSignal } = {}): Promise<SandboxBinding | null> {
    if (this.binding) return this.binding;

    const builderCfg = this.readBuilderConfig();
    if (!builderCfg) return null;

    // Resolve the primary stack + limits. Three supported shapes:
    //   1. Legacy `{ stack, limits }` — used verbatim.
    //   2. Multi-service `{ services: [...] }` — pick the entry with
    //      `primary: true`, or fall back to the first entry.
    //   3. Both present — prefer the explicit primary entry in services,
    //      but fall back to the legacy `stack` for back-compat.
    let stack = builderCfg.stack;
    let limits = builderCfg.limits;
    if (builderCfg.services && builderCfg.services.length > 0) {
      const primary =
        builderCfg.services.find((s) => s.primary) ?? builderCfg.services[0]!;
      stack = (primary.stack as SandboxStack) ?? stack;
      limits = primary.limits ?? limits;
    }
    if (!stack) return null;

    const manager = getSandboxManager();
    // Subscribe BEFORE provisioning so the `provisioning` → `ready` events
    // are observed in order (the manager emits `provisioning` synchronously
    // inside `provision()` before awaiting the driver).
    this.unsubscribe = manager.subscribe((e) => this.forwardEvent(e));

    // Resolve the primary project's `root_path` so the sandbox
    // bind-mounts onto the SAME directory the linked virtual project
    // row (`_builder_<uuid>`) points at — NOT the fallback sessionId
    // path. Without this the project dir on disk stays empty while
    // the sandbox writes to a sibling dir nothing indexes.
    const primaryLink =
      builderCfg.main_project_id != null
        ? this.ctx.projects.find((p) => p.project_id === builderCfg.main_project_id)
        : this.ctx.projects.find((p) => !p.label) ?? this.ctx.projects[0];
    const primaryProject = primaryLink ? this.ctx.db.getProject(primaryLink.project_id) : null;
    const hostWorkdirMount = primaryProject?.root_path ?? undefined;
    let externalSpec:
      | {
          mountKind: 'external';
          imageSource: 'project_dockerfile';
          dockerfilePath: string;
          containerPortOverride: number;
          skipDefaultCommand: true;
        }
      | {
          mountKind: 'external';
          imageSource: 'default';
          containerPortOverride: number;
          skipDefaultCommand: false;
        }
      | {} = {};
    if (builderCfg.main_project_id != null) {
      if (!primaryProject) {
        console.warn(
          `[sandbox-service] external main project ${builderCfg.main_project_id} not found for session ${this.sessionKey}`,
        );
        this.unsubscribe?.();
        this.unsubscribe = null;
        return null;
      }
      const manifest = detectManifest(primaryProject.root_path);
      const runtime =
        builderCfg.main_project_runtime ??
        (manifest?.kind === 'node' && manifest.devScriptName ? 'node' : 'dockerfile');
      if (runtime === 'node') {
        if (!manifest || manifest.kind !== 'node' || !manifest.devScriptName) {
          console.warn(
            `[sandbox-service] external main project for session ${this.sessionKey} has no package.json dev/start/serve script`,
          );
          this.unsubscribe?.();
          this.unsubscribe = null;
          return null;
        }
        externalSpec = {
          mountKind: 'external',
          imageSource: 'default',
          containerPortOverride: inferExternalNodePort(stack, manifest),
          skipDefaultCommand: false,
        };
      } else {
        const dockerfile = detectDockerfile(primaryProject.root_path);
        const firstPort = dockerfile?.exposedPorts[0];
        if (!dockerfile || !firstPort) {
          console.warn(
            `[sandbox-service] external main project for session ${this.sessionKey} has no Dockerfile EXPOSE port`,
          );
          this.unsubscribe?.();
          this.unsubscribe = null;
          return null;
        }
        externalSpec = {
          mountKind: 'external',
          imageSource: 'project_dockerfile',
          dockerfilePath: dockerfile.path,
          containerPortOverride: firstPort,
          skipDefaultCommand: true,
        };
      }
    }

    // Archive restore is handled inside SandboxManager.provision now —
    // no need to load here. That guarantees every provision path
    // (eager POST, service, test) gets the same behavior.
    const includeE2e = this.detectIncludeE2e();

    let sandbox: Sandbox;
    try {
      sandbox = await manager.provision({
        sessionId: this.sessionKey,
        stack,
        signal: opts.signal,
        limits,
        hostWorkdirMount,
        includeE2e,
        image: builderCfg.image,
        runArgs: builderCfg.runArgs,
        ...externalSpec,
      });
    } catch (e) {
      // Non-fatal: the master can still operate in builder mode even when
      // the primary container fails to start (Docker down, capacity, etc.).
      // Return null so MasterLifecycle can start without a live binding.
      console.warn(
        `[sandbox-service] provision failed for session ${this.sessionKey} — master will start without a live sandbox binding: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.unsubscribe?.();
      this.unsubscribe = null;
      return null;
    }

    // QA wiring v4.0: when the session has a role with the
    // `qa-playwright` skill (`includeE2e=true`), point it at the
    // SHARED Chrome Service singleton. The Chrome Service container
    // is provisioned independently by the operator via the Admin
    // Panel — we just inject `PLAYWRIGHT_WS_ENDPOINT` into the
    // session env. When the service is disabled, the agent will get
    // a clear `alive:false` from `qa_get_browser_endpoint` instead
    // of a confusing connection error mid-spec.
    if (includeE2e) {
      try {
        await wireSessionToChromeService(this.ctx.companySessionId, manager);
      } catch (e) {
        console.warn(
          `[sandbox-service] chrome service wiring failed for session ${this.sessionKey}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // `resolveDriver` returns the same process-wide singleton the manager
    // used internally, so this is a cheap lookup, not a duplicate probe.
    const driver = await resolveDriver();
    this.binding = this.buildBinding(driver, sandbox, null);

    // Rehydrate in-memory service bindings from the manager. The manager
    // owns a process-wide services Map that survives SandboxService
    // instance recreation (e.g. server restart / orchestrator recreate).
    // Without this, `getServiceBinding(label)` returns null for services
    // that ALREADY exist — which makes `resolveBindingForProject` fall
    // back to the primary binding and subordinates for microservices end
    // up writing inside the PRIMARY container (wrong workdir, wrong
    // stack). Observed on session 67: the `cloudflare` subordinate
    // linked to the `api-worker` service ran its `list_directory` inside
    // the react-ts container because this map was empty.
    this.hydrateServiceBindingsFromManager(manager, driver);

    return this.binding;
  }

  /**
   * Fill `serviceBindings` from the manager's in-memory service map.
   * Safe to call multiple times — it replaces the whole map each time,
   * so a service that the manager dropped (destroyed) also disappears
   * from here. No DB reads: the manager already reconciled from DB at
   * bootstrap via `reconcileServicesFromDb`.
   */
  private hydrateServiceBindingsFromManager(
    manager: ReturnType<typeof getSandboxManager>,
    driver: Awaited<ReturnType<typeof resolveDriver>>,
  ): void {
    const pairs = manager.listServicesWithIds(this.sessionKey);
    const seen = new Set<string>();
    for (const { serviceId, sandbox: svc } of pairs) {
      this.serviceBindings.set(serviceId, this.buildBinding(driver, svc, serviceId));
      seen.add(serviceId);
    }
    // Drop stale entries the manager no longer knows about.
    for (const key of [...this.serviceBindings.keys()]) {
      if (!seen.has(key)) this.serviceBindings.delete(key);
    }
  }

  /**
   * Stand up a secondary microservice container for this session.
   * Returns the binding consumers can use to target tool calls at the
   * new service. Secondary containers can be started independently of
   * the primary sandbox.
   */
  async addService(opts: {
    serviceId: string;
    stack: SandboxStack;
    name?: string;
    limits?: { memory?: string; cpus?: string; pids?: number };
    signal?: AbortSignal;
    /**
     * Absolute host path to bind-mount onto the service workdir. The
     * route layer creates a real projects row for this service and
     * supplies its `root_path` here so the microservice lives as a
     * peer project on disk, listable/indexable from the Projects UI.
     */
    hostWorkdirMount?: string;
    mountKind?: 'owned' | 'external';
    imageSource?: 'default' | 'project_dockerfile';
    dockerfilePath?: string;
    containerPortOverride?: number;
    skipDefaultCommand?: boolean;
  }): Promise<SandboxBinding> {
    const manager = getSandboxManager();
    const sandbox = await manager.provisionAdditionalService({
      sessionId: this.sessionKey,
      serviceId: opts.serviceId,
      stack: opts.stack,
      name: opts.name,
      limits: opts.limits,
      signal: opts.signal,
      hostWorkdirMount: opts.hostWorkdirMount,
      mountKind: opts.mountKind,
      imageSource: opts.imageSource,
      dockerfilePath: opts.dockerfilePath,
      containerPortOverride: opts.containerPortOverride,
      skipDefaultCommand: opts.skipDefaultCommand,
    });
    const driver = await resolveDriver();
    const binding: SandboxBinding = this.buildBinding(driver, sandbox, opts.serviceId);
    this.serviceBindings.set(opts.serviceId, binding);
    this.publisher.publish('sandbox.service.added', {
      sandboxId: this.sessionKey,
      serviceId: opts.serviceId,
      stack: opts.stack,
      previewUrl: sandbox.previewUrl,
      at: Date.now(),
    });
    return binding;
  }

  /** Tear down a single secondary service. */
  async removeService(serviceId: string): Promise<void> {
    const manager = getSandboxManager();
    this.serviceBindings.delete(serviceId);
    try {
      await manager.destroyService(this.sessionKey, serviceId, 'user-removed');
    } catch (e) {
      console.warn(
        `[sandbox-service] removeService ${this.sessionKey}:${serviceId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.publisher.publish('sandbox.service.removed', {
      sandboxId: this.sessionKey,
      serviceId,
      at: Date.now(),
    });
  }

  /**
   * Called by the orchestrator when the session finishes (graceful end
   * OR abort). Destroys the sandbox and stops forwarding events.
   */
  async teardown(reason = 'session-end'): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;

    // Tear secondary services down first; SandboxManager.destroyAll
    // does the same ordering so the shared network is freed cleanly.
    const serviceIds = [...this.serviceBindings.keys()];
    this.serviceBindings.clear();
    const manager = getSandboxManager();
    await Promise.allSettled(
      serviceIds.map((serviceId) => manager.destroyService(this.sessionKey, serviceId, reason)),
    );

    if (!this.binding) return;
    this.binding = null;

    // Archive is handled inside SandboxManager.destroyInternal now —
    // ALL destroy paths (TTL reaper, server-restart reaper, explicit
    // abort, delete) persist uniformly, not just teardown. This call
    // is simply a delegated destroy.
    try {
      await manager.destroy(this.sessionKey, reason);
    } catch (e) {
      console.warn(
        `[sandbox-service] teardown ${this.sessionKey} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Emit a `sandbox.file_changed` event on the metaBus so the dashboard
   * can auto-reload the preview iframe. Called from the subordinate
   * runner's `onToolCall('after')` hook whenever a file-writing tool
   * succeeds inside a builder session.
   */
  publishFileChanged(paths: string[]): void {
    this.publisher.publish('sandbox.file_changed', {
      sandboxId: this.sessionKey,
      paths,
      at: Date.now(),
    });
  }

  // ─────────────────────────────────────────────────────────── internals

  /**
   * Construct a SandboxBinding whose `containerId` is resolved live
   * against SandboxManager on every read. See the comment on
   * `SandboxBinding.containerId` in company/types.ts for motivation.
   *
   * The initial id captured from `sandbox.containerId` is the fallback
   * used when the manager can't resolve (e.g. during a brief window
   * between `destroyInternal` and a following `provision`).
   */
  private buildBinding(
    driver: SandboxBinding['driver'],
    sandbox: Sandbox,
    serviceId: string | null,
  ): SandboxBinding {
    const initialContainerId = sandbox.containerId;
    const sessionKey = this.sessionKey;
    const svcId = serviceId ?? undefined;
    const binding: SandboxBinding = {
      driver,
      workdir: sandbox.workdir,
      previewUrl: sandbox.previewUrl,
      // Forward the host bind-mount path so DS tools can translate
      // container `/app/X` paths into the host equivalent for
      // `npm pack`, `readFile`, etc. Sandbox without bind-mount
      // (ephemeral fs) leaves this undefined — DS tools use the
      // absence as a signal to fail with a useful error.
      ...(sandbox.hostWorkdirMount ? { hostWorkdirMount: sandbox.hostWorkdirMount } : {}),
      get containerId(): string {
        const live = getSandboxManager().resolveContainerId(sessionKey, svcId);
        return live ?? initialContainerId;
      },
    };
    if (svcId) binding.serviceId = svcId;
    return binding;
  }

  private forwardEvent(event: SandboxEvent): void {
    if (event.sandboxId !== this.sessionKey) return;
    // Publish on the company metaBus under a stable `sandbox.*` envelope.
    // The UI subscribes to these events to drive the preview pane.
    this.publisher.publish(`sandbox.${event.kind}`, event);

    // P14b — high-frequency `stats` events skip the secondary
    // service-status broadcast so the dashboard doesn't refetch
    // /services every second.
    if (event.kind === 'stats' || event.kind === 'log' || event.kind === 'step') return;

    // Any non-stats lifecycle transition of the primary sandbox is
    // also a "services list" mutation from the dashboard's
    // perspective (the primary is a service row in `/services`).
    // Publishing this synthetic event lets `useExtraServices` /
    // `useServicesPolling` refetch on the same SSE wakeup without
    // adding a second subscription path.
    this.publisher.publish('sandbox.service.status_changed', {
      sandboxId: event.sandboxId,
      kind: event.kind,
    });
  }

}
