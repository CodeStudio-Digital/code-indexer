/**
 * ChromeService — singleton runtime that owns the SHARED Playwright
 * browser container. Exactly one instance per host, gated by the
 * admin-managed config (`chrome_service_configs`).
 *
 * Architecturally mirrors `McpServerManager`: a thin wrapper around
 * a runtime driver (Docker/Podman) that exposes lifecycle methods
 * + a snapshot accessor for routes/tools to consult.
 *
 * Lifecycle:
 *   stopped/error → `enable()` → starting → running       (on success)
 *                              → error                     (on failure; persists last_error)
 *   running        → `disable()` → stopped
 *   running/error  → `restart()` → stopped → enable()
 *   any            → `recoverOnBoot()` → enable() if `enabled=true`
 *
 * Side-effects on `enable()`/`disable()`:
 *   - Inject/remove `PLAYWRIGHT_WS_ENDPOINT` in `companySessionEnvStore`
 *     for every active session whose role_assignments include the
 *     `qa-playwright` skill (backfill / cleanup).
 *   - Trigger `SandboxManager.syncEnvsToAllContainers(sessionId)` for
 *     each affected session that has a live sandbox so `.env` inside
 *     the container gets the new value without a restart.
 */
import { resolveDriver, getResolvedRuntime } from '../sandbox/index.js';
import type { ISandboxDriver } from '../sandbox/ports/sandbox-driver.js';
import {
  DEFAULT_SANDBOX_ISOLATION,
  DEFAULT_SANDBOX_LIMITS,
} from '../sandbox/types.js';
import type { ChromeServiceStore, ChromeServiceConfig } from '../../store/chrome-service-store.js';
import type { CompanyStore } from '../../store/company-store.js';
import type { CompanySessionEnvStore } from '../../store/company-session-env-store.js';
import { getSandboxManager } from '../sandbox/index.js';
import { hasQaPlaywrightSkill } from '../coder/company/services/SandboxService.js';
import {
  buildHostFacingWsEndpoint,
  buildLoopbackHealthUrl,
  classifyChromeServiceError,
  DEFAULT_CHROME_SERVICE_PORT,
} from './host-alias.js';

const HEALTHCHECK_BUDGET_MS = 60_000;
const HEALTHCHECK_POLL_INTERVAL_MS = 500;
const SPAWN_TIMEOUT_MS = 15_000;

export interface ChromeServiceState {
  enabled: boolean;
  status: ChromeServiceConfig['status'];
  image: string;
  hostPort: number;
  containerId: string | null;
  /** WS URL siblings (sandboxes) use to connect via host alias. */
  wsEndpoint: string;
  /** HTTP URL the host process uses to probe the run-server. */
  loopbackHealthUrl: string;
  lastError: string | null;
  startedAt: string | null;
  /** Live healthcheck verdict — only set when callers ask for it. */
  alive?: boolean;
}

export interface ChromeServiceDeps {
  store: ChromeServiceStore;
  companyStore: CompanyStore;
  envStore: CompanySessionEnvStore;
  /**
   * Operator-configured http-api port. Used by `recoverOnBoot` to
   * verify the API process is reachable from the runtime gateway
   * (`host.containers.internal:<port>` for Podman). When the API is
   * bound to `127.0.0.1` instead of `0.0.0.0`, sibling containers
   * cannot reach it — and the QA preview proxy traffic silently fails
   * later. The check surfaces the gap at boot, with a clear hint.
   *
   * Optional — when absent the check is skipped (tests, CLI paths).
   */
  httpApiPort?: number;
}

export class ChromeService {
  private readonly store: ChromeServiceStore;
  private readonly companyStore: CompanyStore;
  private readonly envStore: CompanySessionEnvStore;
  private readonly httpApiPort: number | undefined;
  private startInFlight: Promise<ChromeServiceState> | null = null;

  constructor(deps: ChromeServiceDeps) {
    this.store = deps.store;
    this.companyStore = deps.companyStore;
    this.envStore = deps.envStore;
    this.httpApiPort = deps.httpApiPort;
  }

  /** Snapshot accessor — never throws. Includes a quick liveness probe. */
  async getEndpoint(opts: { probe?: boolean } = {}): Promise<ChromeServiceState> {
    const cfg = this.store.getConfig();
    const state = toState(cfg);
    if (opts.probe && state.status === 'running') {
      const probe = await fetchVersion(state.loopbackHealthUrl, 4_000);
      state.alive = probe.ok;
      if (!probe.ok && probe.error) state.lastError = probe.error;
    } else if (state.status === 'running') {
      // Without a probe we trust the persisted status — the caller can
      // pay the latency cost when they care about freshness.
      state.alive = true;
    } else {
      state.alive = false;
    }
    return state;
  }

  /**
   * Provision the Chrome container, healthcheck it, persist `running`,
   * and backfill the env var into every eligible active session.
   * Idempotent: when called concurrently the second invocation reuses
   * the same in-flight promise.
   */
  async enable(): Promise<ChromeServiceState> {
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.doEnable();
    try {
      return await this.startInFlight;
    } finally {
      this.startInFlight = null;
    }
  }

  private async doEnable(): Promise<ChromeServiceState> {
    let cfg = this.store.patch({ enabled: true });
    cfg = this.store.setStatus({ status: 'starting', last_error: null });

    const driver = await resolveDriver();
    let containerId = '';
    try {
      // Tear down any stale container from a previous run that we didn't
      // get to clean up (server crash). Best-effort.
      if (cfg.container_id) {
        try {
          await driver.destroy(cfg.container_id);
        } catch {
          /* swallow */
        }
      }

      const created = await driver.create({
        sandboxId: 'chrome-service',
        image: cfg.image,
        // Stack value is informational for our drivers — `react-ts`
        // is harmless because the chrome service never runs scaffold.
        stack: 'react-ts',
        workdir: '/ms-playwright',
        hostPort: cfg.host_port,
        containerPort: DEFAULT_CHROME_SERVICE_PORT,
        // Bind on 0.0.0.0 (not the default loopback): sandbox
        // containers reach this service via `host.containers.internal`
        // / `host.docker.internal`, which resolve to the runtime
        // network gateway. The gateway only forwards to ports bound
        // on all interfaces — 127.0.0.1-only binds are invisible to
        // sibling containers on a custom docker network. v4.0.1 fix.
        hostBindAddr: '0.0.0.0',
        limits: {
          ...DEFAULT_SANDBOX_LIMITS,
          memory: process.env.MCP_PLAYWRIGHT_SIDECAR_MEMORY ?? '2g',
          // Chromium spawns ~50–200 threads per browser context, plus
          // its own renderer/GPU/network/utility processes. The default
          // sandbox PID limit (256) sufficed for a Vite dev server but
          // sufocated Chromium with `pthread_create: Resource
          // temporarily unavailable` during page load. 8192 covers
          // multiple concurrent contexts comfortably; tunable via
          // MCP_PLAYWRIGHT_SIDECAR_PIDS for memory-constrained hosts.
          pids: Number(process.env.MCP_PLAYWRIGHT_SIDECAR_PIDS ?? '8192') || 8192,
        },
        isolation: {
          ...DEFAULT_SANDBOX_ISOLATION,
          // Default sandbox network is fine — we publish the host port,
          // not via shared network.
        },
        env: { PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' },
      });
      containerId = created.containerId;

      // Launch run-server in the background. The image's CMD is
      // `bash`; we spawn the server explicitly via `nohup ... &`.
      const launch = await driver.exec(
        containerId,
        `nohup npx playwright run-server --port ${DEFAULT_CHROME_SERVICE_PORT} --host 0.0.0.0 > /tmp/run-server.log 2>&1 &`,
        { cwd: '/ms-playwright', timeoutMs: SPAWN_TIMEOUT_MS },
      );
      if (launch.exitCode !== 0) {
        throw new Error(
          `playwright run-server failed to spawn: ${launch.stderr || launch.stdout}`,
        );
      }

      // Health probe via host loopback (we publish `127.0.0.1:hostPort`).
      const healthy = await pollHealth(
        buildLoopbackHealthUrl(cfg.host_port),
        HEALTHCHECK_BUDGET_MS,
      );
      if (!healthy.ok) {
        const logs = await driver.exec(
          containerId,
          'tail -n 80 /tmp/run-server.log || true',
          { cwd: undefined, timeoutMs: 5_000 },
        );
        const classified = classifyChromeServiceError(logs.stdout || '');
        throw new Error(
          `Chrome service healthcheck failed (${classified.kind}): ${classified.hint}\n--- run-server.log ---\n${logs.stdout}`,
        );
      }

      cfg = this.store.setStatus({
        status: 'running',
        container_id: containerId,
        last_error: null,
        started_at: new Date().toISOString(),
      });
      console.log(
        `[chrome-service] up — image=${cfg.image} host_port=${cfg.host_port} ws=${buildHostFacingWsEndpoint(getResolvedRuntime(), cfg.host_port)}`,
      );

      // Backfill env var into eligible active sessions.
      await this.backfillEndpointToActiveSessions(cfg);

      return toState(cfg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Best-effort destroy of the container we managed to create.
      if (containerId) {
        try { await driver.destroy(containerId); } catch { /* swallow */ }
      }
      this.store.setStatus({
        status: 'error',
        container_id: null,
        last_error: msg,
      });
      console.warn(`[chrome-service] enable failed: ${msg}`);
      throw e;
    }
  }

  /** Tear down the container, clear injected env vars, mark stopped. */
  async disable(): Promise<void> {
    const cfg = this.store.getConfig();
    const driver = cfg.container_id ? await resolveDriver() : null;

    if (driver && cfg.container_id) {
      try {
        await driver.destroy(cfg.container_id);
      } catch (e) {
        console.warn(
          `[chrome-service] destroy failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Clear endpoint env vars from active sessions.
    await this.clearEndpointFromActiveSessions();

    this.store.patch({ enabled: false });
    this.store.setStatus({
      status: 'stopped',
      container_id: null,
      last_error: null,
    });
  }

  async restart(): Promise<ChromeServiceState> {
    await this.disable();
    return this.enable();
  }

  /**
   * Boot-time recovery — chamada do `server.ts`. If config says
   * `enabled=true`, attempt to bring the container up. Always best-effort
   * (failure logs warning, doesn't crash the server).
   */
  async recoverOnBoot(): Promise<void> {
    const cfg = this.store.getConfig();
    if (!cfg.enabled) {
      console.log('[chrome-service] disabled — boot recovery skipped');
      return;
    }

    // Reachability check: when QA is enabled, the Chrome Service must be
    // able to reach this http-api process via the runtime gateway alias
    // (`host.containers.internal:<httpApiPort>`). The most common failure
    // mode is the API bound to `127.0.0.1` instead of `0.0.0.0` — siblings
    // can't reach loopback-only ports. Surface a clear warning here so
    // the operator sees it during boot, not as ECONNREFUSED traces later.
    if (typeof this.httpApiPort === 'number' && Number.isFinite(this.httpApiPort)) {
      void this.checkHttpApiReachable(this.httpApiPort).catch(() => {
        /* warnings are logged inside; never throw from boot path */
      });
    }

    console.log('[chrome-service] enabled — boot recovery: provisioning…');
    try {
      await this.enable();
    } catch (e) {
      console.warn(
        `[chrome-service] boot recovery failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Probe `host.{containers,docker}.internal:<httpApiPort>/api/health`
   * (or any endpoint that returns a 200/4xx — anything reachable proves
   * the gateway can route to the API). Best-effort. Logs a clear hint
   * when unreachable so the operator can fix the bind config.
   */
  private async checkHttpApiReachable(port: number): Promise<void> {
    const runtime = getResolvedRuntime();
    const host =
      runtime === 'podman' ? 'host.containers.internal' : 'host.docker.internal';
    const url = `http://${host}:${port}/api/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      if (res.status >= 500) {
        console.warn(
          `[chrome-service] http-api reachability probe via ${host}:${port} returned ${res.status} — QA preview proxy may be degraded.`,
        );
      } else {
        console.log(
          `[chrome-service] http-api reachable via ${host}:${port} (status ${res.status}).`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[chrome-service] WARNING: http-api unreachable from sandbox runtime via ` +
          `${host}:${port} (${msg}). Most likely the API is bound to 127.0.0.1 ` +
          `instead of 0.0.0.0 — fix MCP_INDEX_PORT/host or set MCP_QA_API_BASE.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Loop active sessions → for those with role.skills including
   * `qa-playwright`, write `PLAYWRIGHT_WS_ENDPOINT` (auto-source) and
   * sync `.env` into any live container.
   */
  private async backfillEndpointToActiveSessions(cfg: ChromeServiceConfig): Promise<void> {
    const wsEndpoint = buildHostFacingWsEndpoint(getResolvedRuntime(), cfg.host_port);
    const sessions = this.collectEligibleSessions();
    if (sessions.length === 0) return;

    const manager = getSandboxManager();
    for (const sessionId of sessions) {
      try {
        this.envStore.upsert(sessionId, 'PLAYWRIGHT_WS_ENDPOINT', wsEndpoint, false, {
          source: 'auto',
        });
        // Sync only if a live sandbox exists; method is no-op otherwise.
        await manager.syncEnvsToAllContainers(String(sessionId));
      } catch (e) {
        console.warn(
          `[chrome-service] backfill ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    console.log(
      `[chrome-service] backfilled PLAYWRIGHT_WS_ENDPOINT into ${sessions.length} active session(s)`,
    );
  }

  private async clearEndpointFromActiveSessions(): Promise<void> {
    const sessions = this.collectEligibleSessions();
    if (sessions.length === 0) return;
    const manager = getSandboxManager();
    for (const sessionId of sessions) {
      try {
        this.envStore.delete(sessionId, 'PLAYWRIGHT_WS_ENDPOINT');
        await manager.syncEnvsToAllContainers(String(sessionId));
      } catch {
        /* swallow per-session — disable should always proceed */
      }
    }
  }

  /**
   * Pure-ish: return the numeric ids of company sessions that are
   * "active" (status not in completed/error) AND have at least one
   * role with the `qa-playwright` skill in their config.
   *
   * Reads via `companyStore.listCompanySessions()` + the pure
   * `hasQaPlaywrightSkill(config_json)` helper.
   */
  private collectEligibleSessions(): number[] {
    const all = this.companyStore.listCompanySessions();
    const out: number[] = [];
    for (const s of all) {
      if (s.status === 'completed' || s.status === 'error') continue;
      if (hasQaPlaywrightSkill(s.config_json ?? '')) out.push(s.id);
    }
    return out;
  }
}

// ─── Pure helpers (exported for tests) ───────────────────────────

function toState(cfg: ChromeServiceConfig): ChromeServiceState {
  const runtime = getResolvedRuntime();
  return {
    enabled: cfg.enabled,
    status: cfg.status,
    image: cfg.image,
    hostPort: cfg.host_port,
    containerId: cfg.container_id,
    wsEndpoint: buildHostFacingWsEndpoint(runtime, cfg.host_port),
    loopbackHealthUrl: buildLoopbackHealthUrl(cfg.host_port),
    lastError: cfg.last_error,
    startedAt: cfg.started_at,
  };
}

interface VersionProbe {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Probe the run-server health URL. `playwright run-server` answers any
 * GET with `"Running"` (plain text, 200) — we ONLY check the status,
 * not the body. Tying the probe to `res.json()` was the v4.0 bug
 * (parser threw on plain-text body, so `last_error` filled with
 * "Unexpected token 'R'..." even though the server was healthy).
 */
async function fetchVersion(url: string, timeoutMs: number): Promise<VersionProbe> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    try { await res.text(); } catch { /* swallow body drain */ }
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function pollHealth(
  url: string,
  totalTimeoutMs: number,
): Promise<{ ok: boolean; lastStatus?: number; lastError?: string }> {
  const deadline = Date.now() + totalTimeoutMs;
  let lastError: string | undefined;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      // Drain body so keep-alive doesn't block the next probe iteration.
      try { await res.text(); } catch { /* swallow */ }
      lastStatus = res.status;
      if (res.ok) return { ok: true, lastStatus };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, HEALTHCHECK_POLL_INTERVAL_MS));
  }
  return { ok: false, lastStatus, lastError };
}

// ─── Process-wide singleton ──────────────────────────────────────

let singleton: ChromeService | null = null;

/** Wire the singleton once at boot from `server.ts`. */
export function setChromeService(svc: ChromeService | null): void {
  singleton = svc;
}

/** Throws when the singleton hasn't been wired yet — caller mistake. */
export function getChromeService(): ChromeService {
  if (!singleton) throw new Error('ChromeService not wired — call setChromeService() at boot');
  return singleton;
}

/** Soft accessor used by tools — returns null instead of throwing. */
export function tryGetChromeService(): ChromeService | null {
  return singleton;
}
