/**
 * VerdaccioService — singleton runtime that owns the embedded
 * Verdaccio npm registry container. Exactly one instance per host,
 * gated by the admin-managed config (`verdaccio_configs`, migration 049).
 *
 * Mirrors `ChromeService` (chrome-service.ts):
 *   - Provisions a single container via the sandbox driver.
 *   - Healthchecks via GET `/-/ping` (Verdaccio's standard endpoint).
 *   - Persists state and exposes a snapshot to routes.
 *   - `recoverOnBoot()` re-spawns when the operator left it enabled.
 *
 * Beyond ChromeService, this service exposes `publishTarball()` so the
 * Design System Creator pipeline can `npm publish` a built package
 * tarball without spawning a separate sandbox each time.
 *
 * Lifecycle:
 *   stopped/error → enable() → starting → running    (success)
 *                            → error                 (failure; persists last_error)
 *   running       → disable() → stopped
 *   any           → restart() → disable + enable
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStorageBindPath } from './storage-paths.js';
import { resolveDriver, getResolvedRuntime } from '../sandbox/index.js';
import {
  DEFAULT_SANDBOX_ISOLATION,
  DEFAULT_SANDBOX_LIMITS,
} from '../sandbox/types.js';
import type { VerdaccioStore, VerdaccioConfig } from '@mcp/store/verdaccio-store.js';
import { runNpm } from '@mcp/design-system/run-npm.js';

const HEALTHCHECK_BUDGET_MS = 60_000;
const HEALTHCHECK_POLL_INTERVAL_MS = 500;
const PUBLISH_TIMEOUT_MS = 60_000;
const SPAWN_TIMEOUT_MS = 15_000;
const DEFAULT_VERDACCIO_PORT = 4873;
const VERDACCIO_INTERNAL_PORT = 4873;

/**
 * Pure: shape the shell command that boots the verdaccio daemon
 * inside the container. Extracted as a function (not a string literal
 * inline) so unit tests can lock the port substitution and `--listen`
 * presence — both are load-bearing for the container actually binding
 * the port the host process polls.
 *
 * - The verdaccio image installs the binary at `/usr/local/bin/verdaccio`
 *   (PATH). We pass `--listen` explicitly so the daemon binds 0.0.0.0
 *   even if the shipped config drifts in a future image release.
 * - `nohup … &` detaches so the exec call returns immediately; the
 *   daemon survives the parent shell exit.
 * - `/tmp/verdaccio.log` is system-writable and survives long enough
 *   for the diagnostics tail on healthcheck failure.
 */
export function buildVerdaccioSpawnCommand(internalPort: number): string {
  return `nohup verdaccio --config /verdaccio/conf/config.yaml --listen http://0.0.0.0:${internalPort} > /tmp/verdaccio.log 2>&1 &`;
}

export interface VerdaccioState {
  enabled: boolean;
  status: VerdaccioConfig['status'];
  image: string;
  hostPort: number;
  containerId: string | null;
  /** Loopback URL — host process uses this to publish or proxy. */
  loopbackUrl: string;
  /** Host-facing URL — sibling containers (company sandboxes) reach via host alias. */
  registryUrl: string;
  lastError: string | null;
  startedAt: string | null;
  alive?: boolean;
  maxPatchVersionsPerMinor: number;
}

export interface VerdaccioDeps {
  store: VerdaccioStore;
}

export interface PublishTarballInput {
  /** Absolute path on the host filesystem. */
  tarballPath: string;
  /** For logging — package@semver. Verdaccio reads the actual values from the tarball's package.json. */
  packageName: string;
  semver: string;
}

export interface PublishTarballResult {
  ok: boolean;
  registryUrl: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class VerdaccioService {
  private readonly store: VerdaccioStore;
  private startInFlight: Promise<VerdaccioState> | null = null;
  private startingContainerId: string | null = null;
  private shuttingDown = false;

  constructor(deps: VerdaccioDeps) {
    this.store = deps.store;
  }

  async getEndpoint(opts: { probe?: boolean } = {}): Promise<VerdaccioState> {
    const cfg = this.store.getConfig();
    const state = toState(cfg);
    if (opts.probe && state.status === 'running') {
      const probe = await fetchPing(state.loopbackUrl, 4_000);
      state.alive = probe.ok;
      if (!probe.ok && probe.error) state.lastError = probe.error;
    } else if (state.status === 'running') {
      state.alive = true;
    } else {
      state.alive = false;
    }
    return state;
  }

  async enable(): Promise<VerdaccioState> {
    if (this.shuttingDown) throw new Error('Verdaccio is shutting down');
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.doEnable();
    try {
      return await this.startInFlight;
    } finally {
      this.startInFlight = null;
    }
  }

  private async doEnable(): Promise<VerdaccioState> {
    let cfg = this.store.patch({ enabled: true });
    cfg = this.store.setStatus({ status: 'starting', last_error: null });

    const driver = await resolveDriver();
    let containerId = '';
    try {
      if (cfg.container_id) {
        try { await driver.destroy(cfg.container_id); } catch { /* swallow */ }
      }

      // Resolve a persistent host directory for `/verdaccio/storage`.
      // Without this the verdaccio image attaches an anonymous Docker
      // volume to that path and every container destroy (i.e. every
      // `doEnable` cycle) wipes the htpasswd + every published .tgz.
      // The persisted `upstream_token` then refers to a user that no
      // longer exists and the next `npm publish` fails E401 (session
      // 73 incident on second restart).
      const storageBind = resolveStorageBindPath({
        override: process.env.MCP_VERDACCIO_STORAGE_DIR ?? null,
      });
      try {
        await mkdir(storageBind, { recursive: true });
      } catch (e) {
        throw new Error(
          `Failed to create Verdaccio storage dir ${storageBind}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const created = await driver.create({
        sandboxId: 'verdaccio-registry',
        image: cfg.image,
        // Stack is informational — we never scaffold inside Verdaccio.
        stack: 'react-ts',
        workdir: '/verdaccio/storage',
        // Bind-mount the host directory onto the container's storage
        // path. Survives container destroy → re-create cycles, so users
        // and tarballs persist across operator restarts.
        hostWorkdirMount: storageBind,
        hostPort: cfg.host_port,
        containerPort: VERDACCIO_INTERNAL_PORT,
        // Bind on 0.0.0.0 so sibling sandbox containers can reach via
        // `host.containers.internal` / `host.docker.internal`.
        hostBindAddr: '0.0.0.0',
        limits: {
          ...DEFAULT_SANDBOX_LIMITS,
          memory: process.env.MCP_VERDACCIO_MEMORY ?? '512m',
        },
        isolation: { ...DEFAULT_SANDBOX_ISOLATION },
      });
      containerId = created.containerId;
      this.startingContainerId = containerId;
      if (this.shuttingDown) throw new Error('Verdaccio is shutting down');

      // The verdaccio image ships `/verdaccio/storage` owned by uid
      // 10001 (`verdacci` user inside the image), but our sandbox
      // isolation forces the container process to run as uid 1000
      // (`node`). Without a chown, the daemon hits EACCES when it
      // tries to create `htpasswd` on first `npm adduser`, so user
      // registration fails with HTTP 500 and `npm publish` then fails
      // with ENEEDAUTH. Session 73 incident — root cause documented
      // in plan file. Run as root via `user: '0:0'` exec override.
      const chown = await driver.exec(
        containerId,
        'chown -R 1000:1000 /verdaccio/storage',
        { cwd: undefined, timeoutMs: 10_000, user: '0:0' },
      );
      if (chown.exitCode !== 0) {
        // Non-fatal: maybe the chown succeeded a previous boot and
        // the dir is already correct, or the image changed. Log and
        // continue; the daemon will tell us via the healthcheck if
        // permissions are still wrong.
        console.warn(
          `[verdaccio] storage chown returned exit ${chown.exitCode}: ${chown.stderr || chown.stdout}`,
        );
      }

      // CliOciDriver.create() runs `tail -f /dev/null` to keep the
      // container alive — this overrides the image's CMD. Verdaccio's
      // daemon must be started explicitly via exec, mirroring the
      // chrome-service pattern.
      const launch = await driver.exec(
        containerId,
        buildVerdaccioSpawnCommand(VERDACCIO_INTERNAL_PORT),
        { cwd: undefined, timeoutMs: SPAWN_TIMEOUT_MS },
      );
      if (launch.exitCode !== 0) {
        throw new Error(
          `verdaccio daemon failed to spawn (exit ${launch.exitCode}): ${launch.stderr || launch.stdout}`,
        );
      }

      const healthy = await pollPing(
        buildLoopbackUrl(cfg.host_port) + '/-/ping',
        HEALTHCHECK_BUDGET_MS,
      );
      if (!healthy.ok) {
        const containerLogs = await driver.getContainerLogs(containerId, 200).catch(() => '');
        const spawnLog = await driver
          .exec(containerId, 'tail -n 100 /tmp/verdaccio.log 2>/dev/null || true',
                { cwd: undefined, timeoutMs: 5_000 })
          .then((r) => r.stdout)
          .catch(() => '');
        throw new Error(
          [
            `Verdaccio healthcheck failed (last status=${healthy.lastStatus ?? 'n/a'}, last error=${healthy.lastError ?? 'none'})`,
            '--- container logs (tail) ---',
            containerLogs.trim() || '(empty)',
            '--- /tmp/verdaccio.log (tail) ---',
            spawnLog.trim() || '(empty)',
          ].join('\n'),
        );
      }

      if (this.shuttingDown) throw new Error('Verdaccio is shutting down');

      cfg = this.store.setStatus({
        status: 'running',
        container_id: containerId,
        last_error: null,
        started_at: new Date().toISOString(),
      });
      this.startingContainerId = null;
      // Record the persisted storage path so the admin panel can show
      // it and the operator knows where backups live.
      if (cfg.storage_path !== storageBind) {
        cfg = this.store.patch({ storage_path: storageBind });
      }
      console.log(
        `[verdaccio] up — image=${cfg.image} host_port=${cfg.host_port} storage=${storageBind} url=${buildHostFacingUrl(getResolvedRuntime() ?? 'podman', cfg.host_port)}`,
      );

      // Zero-config bootstrap + defensive token revalidation.
      //
      // Two paths:
      //  (a) `upstream_token` is missing → fresh install. Create the
      //      `dsadmin` user via Verdaccio's CouchDB-style API and stash
      //      the returned token. Without this, fresh installs hit
      //      ENEEDAUTH on the first `npm publish` (session 73 case A).
      //  (b) `upstream_token` is set BUT no longer authenticates → the
      //      htpasswd was wiped (operator deleted `data/packages/` or
      //      we're upgrading from a pre-bind-mount install where the
      //      anonymous volume rotated on every restart). Clear the
      //      stale token and re-bootstrap. Without this, publish hits
      //      E401 "your authentication token seems to be invalid"
      //      (session 73 case B, on second restart).
      const tokenIsValid = cfg.upstream_token
        ? await this.verifyTokenStillAuthenticates(cfg.host_port, cfg.upstream_token)
        : false;
      if (!cfg.upstream_token || !tokenIsValid) {
        if (cfg.upstream_token && !tokenIsValid) {
          console.warn(
            `[verdaccio] persisted token no longer authenticates (htpasswd likely wiped or token rotated) — re-bootstrapping`,
          );
          cfg = this.store.patch({ upstream_token: null });
        }
        const passwordReused = !!cfg.bootstrap_password;
        const tokenResult = await this.bootstrapAdminToken(cfg.host_port, cfg.bootstrap_password);
        if (tokenResult.token) {
          // Persist BOTH the password (idempotent — saves once on first
          // bootstrap) and the freshly-issued session token.
          const patch: { upstream_token: string; bootstrap_password?: string } = {
            upstream_token: tokenResult.token,
          };
          if (!passwordReused) {
            patch.bootstrap_password = tokenResult.password;
          }
          cfg = this.store.patch(patch);
          console.log(
            `[verdaccio] bootstrapped ${tokenResult.username} user + persisted token (length=${tokenResult.token.length}, password=${passwordReused ? 'reused' : 'newly-generated'})`,
          );
        } else if (tokenResult.error) {
          // Non-fatal: registry is up; operator can manually `npm adduser`.
          console.warn(`[verdaccio] auto-token bootstrap failed: ${tokenResult.error}`);
        }
      }

      return toState(cfg);
    } catch (e) {
      this.startingContainerId = null;
      const msg = e instanceof Error ? e.message : String(e);
      if (containerId) {
        try { await driver.destroy(containerId); } catch { /* swallow */ }
      }
      this.store.setStatus({
        status: this.shuttingDown ? 'stopped' : 'error',
        container_id: null,
        last_error: this.shuttingDown ? null : msg,
      });
      console.warn(`[verdaccio] enable failed: ${msg}`);
      throw e;
    }
  }

  async disable(): Promise<void> {
    const cfg = this.store.getConfig();
    const driver = cfg.container_id ? await resolveDriver() : null;
    if (driver && cfg.container_id) {
      try {
        await driver.destroy(cfg.container_id);
      } catch (e) {
        console.warn(
          `[verdaccio] destroy failed (continuing): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    this.store.patch({ enabled: false });
    this.store.setStatus({
      status: 'stopped',
      container_id: null,
      last_error: null,
    });
  }

  async restart(): Promise<VerdaccioState> {
    await this.disable();
    return this.enable();
  }

  /** Stop the container while preserving the persisted `enabled` preference. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const cfg = this.store.getConfig();
    const ids = new Set([cfg.container_id, this.startingContainerId].filter((id): id is string => !!id));
    if (ids.size > 0) {
      try {
        const driver = await resolveDriver();
        await Promise.allSettled([...ids].map((id) => driver.destroy(id)));
      } catch (e) {
        console.warn(`[verdaccio] shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.startingContainerId = null;
    this.store.setStatus({ status: 'stopped', container_id: null, last_error: null });
  }

  async recoverOnBoot(): Promise<void> {
    const cfg = this.store.getConfig();
    if (!cfg.enabled) {
      console.log('[verdaccio] disabled — boot recovery skipped');
      return;
    }
    console.log('[verdaccio] enabled — boot recovery: provisioning…');
    try {
      await this.enable();
    } catch (e) {
      console.warn(
        `[verdaccio] boot recovery failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Probe a token against Verdaccio's `/-/whoami` endpoint to confirm
   * it still authenticates. Returns `true` only on a clean 200 with a
   * non-empty username; any other state (HTTP 401, network error,
   * malformed body) returns `false` so the caller re-bootstraps.
   *
   * Why `/-/whoami`: it's the cheapest auth-required endpoint Verdaccio
   * exposes — no side effects, no payload to validate, just "is this
   * Authorization header still good?".
   */
  private async verifyTokenStillAuthenticates(hostPort: number, token: string): Promise<boolean> {
    if (!token) return false;
    try {
      const res = await fetch(`${buildLoopbackUrl(hostPort)}/-/whoami`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const json = (await res.json().catch(() => ({}))) as { username?: string };
      return typeof json.username === 'string' && json.username.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Create or login the `dsadmin` user via Verdaccio's CouchDB-style
   * API and return its session token. Best-effort — never throws;
   * callers fall back to "manual setup" when it fails.
   *
   * Password reuse strategy (post-migration 050):
   *
   * - If `bootstrap_password` is persisted, reuse it. Verdaccio treats
   *   PUT `/-/user/...` with an existing user + correct password as a
   *   LOGIN and returns a fresh session token. Same call doubles as
   *   first-time creation when the storage is fresh.
   * - If no password persisted yet (first-ever run, or a pre-050
   *   install upgrading), generate a fresh one and let the caller
   *   persist it after the PUT succeeds.
   *
   * The previous "always generate new" behaviour deadlocked when the
   * htpasswd file persisted (bind-mount fix) but the DB token was
   * cleared — the new password collided with the existing entry's hash
   * and Verdaccio responded 401 "unauthorized access".
   */
  private async bootstrapAdminToken(hostPort: number, persistedPassword: string | null): Promise<{
    username: string;
    password: string;
    token: string | null;
    error: string | null;
  }> {
    const username = 'dsadmin';
    const password = persistedPassword ?? randomPassword();
    const url = `${buildLoopbackUrl(hostPort)}/-/user/org.couchdb.user:${username}`;
    const body = JSON.stringify({
      name: username,
      password,
      email: 'dsadmin@local',
      type: 'user',
      roles: [],
      date: new Date().toISOString(),
    });
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (res.ok && typeof json.token === 'string' && json.token.length > 0) {
        return { username, password, token: json.token, error: null };
      }
      return {
        username,
        password,
        token: null,
        error: `HTTP ${res.status}: ${json.error ?? 'no token in response'}`,
      };
    } catch (e) {
      return { username, password, token: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Unpublish an entire package (all versions) from Verdaccio.
   *
   * Best-effort: returns `{ ok: false }` instead of throwing when Verdaccio
   * is not running or the package was never published. Never blocks deletion.
   */
  async unpublishPackage(packageName: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const cfg = this.store.getConfig();
    if (cfg.status !== 'running') {
      return { ok: false, stdout: '', stderr: `Verdaccio not running (status=${cfg.status})` };
    }
    const loopbackUrl = buildLoopbackUrl(cfg.host_port);
    const token = cfg.upstream_token ?? '';

    const cwd = join(tmpdir(), `mcp-unpublish-${Date.now()}`);
    await mkdir(cwd, { recursive: true });
    const registryHost = loopbackUrl.replace(/^https?:/, '');
    const npmrc = [
      `registry=${loopbackUrl}/`,
      `${registryHost}/:_authToken=${token}`,
      `${registryHost}/:always-auth=true`,
      'package-lock=false',
    ].join('\n');
    await writeFile(join(cwd, '.npmrc'), npmrc, 'utf8');

    const result = await runNpm({
      args: ['unpublish', packageName, '--force', '--registry', `${loopbackUrl}/`],
      cwd,
      timeoutMs: 30_000,
    });
    if (!result.ok) {
      console.warn(
        `[verdaccio] unpublish failed for ${packageName}: ${result.stderr || result.stdout}`,
      );
    }
    return result;
  }

  /**
   * Publish a tarball produced by the DS pipeline to Verdaccio.
   *
   * Implementation: `npm publish <tarball> --registry <loopbackUrl>` from
   * an ephemeral working directory with a `.npmrc` carrying the upstream
   * token. This avoids spawning a sandbox container for what is a 1-shot
   * action against an HTTP API.
   *
   * Throws when Verdaccio is not running.
   */
  async publishTarball(input: PublishTarballInput): Promise<PublishTarballResult> {
    const cfg = this.store.getConfig();
    if (cfg.status !== 'running') {
      throw new Error(`Verdaccio is not running (status=${cfg.status})`);
    }
    const loopbackUrl = buildLoopbackUrl(cfg.host_port);
    const token = cfg.upstream_token ?? '';

    const cwd = join(tmpdir(), `mcp-publish-${Date.now()}`);
    await mkdir(cwd, { recursive: true });
    const registryHost = loopbackUrl.replace(/^https?:/, '');
    const npmrc = [
      `registry=${loopbackUrl}/`,
      `${registryHost}/:_authToken=${token}`,
      `${registryHost}/:always-auth=true`,
      'package-lock=false',
    ].join('\n');
    await writeFile(join(cwd, '.npmrc'), npmrc, 'utf8');

    const result = await runNpm({
      args: ['publish', input.tarballPath, '--registry', `${loopbackUrl}/`],
      cwd,
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });
    if (!result.ok) {
      console.warn(
        `[verdaccio] publish failed for ${input.packageName}@${input.semver}: ${result.stderr || result.stdout}`,
      );
    }
    return { ...result, registryUrl: loopbackUrl };
  }
}

// ─── Pure helpers ──────────────────────────────────────────────────

function toState(cfg: VerdaccioConfig): VerdaccioState {
  const runtime = getResolvedRuntime() ?? 'podman';
  return {
    enabled: cfg.enabled,
    status: cfg.status,
    image: cfg.image,
    hostPort: cfg.host_port,
    containerId: cfg.container_id,
    loopbackUrl: buildLoopbackUrl(cfg.host_port),
    registryUrl: buildHostFacingUrl(runtime, cfg.host_port),
    lastError: cfg.last_error,
    startedAt: cfg.started_at,
    maxPatchVersionsPerMinor: cfg.max_patch_versions_per_minor,
  };
}

export function buildLoopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * 24-byte (192-bit) random password used solely for the auto-created
 * `dsadmin` user. The actual auth secret consumed by `npm publish` is
 * the session **token** the API returns — this password is never used
 * again after bootstrap. Stored only in Verdaccio's htpasswd and never
 * surfaced to logs / DB.
 */
function randomPassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * URL that sibling sandbox containers use to reach Verdaccio. Same alias
 * convention used by ChromeService — depends on the runtime.
 */
export function buildHostFacingUrl(runtime: string, port: number): string {
  const host = runtime === 'docker' ? 'host.docker.internal' : 'host.containers.internal';
  return `http://${host}:${port}`;
}

interface PingProbe { ok: boolean; status?: number; error?: string; }

async function fetchPing(baseUrl: string, timeoutMs: number): Promise<PingProbe> {
  const url = baseUrl + '/-/ping';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    try { await res.text(); } catch { /* swallow */ }
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function pollPing(
  url: string,
  totalTimeoutMs: number,
): Promise<{ ok: boolean; lastStatus?: number; lastError?: string }> {
  const deadline = Date.now() + totalTimeoutMs;
  let lastError: string | undefined;
  let lastStatus: number | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
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

let singleton: VerdaccioService | null = null;

export function setVerdaccioService(svc: VerdaccioService | null): void {
  singleton = svc;
}

export function getVerdaccioService(): VerdaccioService {
  if (!singleton) throw new Error('VerdaccioService not wired — call setVerdaccioService() at boot');
  return singleton;
}

export function tryGetVerdaccioService(): VerdaccioService | null {
  return singleton;
}
