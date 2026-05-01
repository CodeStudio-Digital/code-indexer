/**
 * SandboxManager — owns the lifecycle of per-session sandboxes.
 *
 * Responsibilities:
 *   - Provision (create container + scaffold) on demand.
 *   - Track live sandboxes in memory keyed by `sandboxId` (= companySessionId).
 *   - Enforce a global concurrency cap (`MAX_SANDBOXES`, env-tunable).
 *   - Reap idle sandboxes after `IDLE_TTL_MS` without touch.
 *   - Clean up on process SIGTERM/SIGINT so containers don't leak.
 *   - Fan out events (`SandboxEvent`) to subscribed observers; the
 *     `SandboxService` bridges those into the company `metaBus` for SSE.
 *
 * The manager is a process-wide singleton — builder mode is a scarce
 * shared resource and coordination is easier with one registry.
 */

import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild } from 'node:child_process';
import { PortAllocator, defaultPortAllocator } from './port-allocator.js';
import type { ISandboxDriver } from './ports/sandbox-driver.js';
import type {
  Sandbox,
  SandboxEvent,
  SandboxLogLine,
  SandboxObserver,
  SandboxStack,
  SandboxStatus,
  SandboxStep,
} from './types.js';
import { DEFAULT_SANDBOX_ISOLATION, DEFAULT_SANDBOX_LIMITS } from './types.js';

const MAX_LOG_LINES = 200;
import { getScaffolder } from './scaffolders/registry.js';
import { resolveDriver, getResolvedRuntime } from './drivers/driver-factory.js';
import { CliOciDriver } from './drivers/cli-oci-driver.js';
import { getNetworkController } from './network-controller.js';
import { buildQaPreviewBaseUrl } from '../qa/url-resolver.js';
import {
  mintPreviewToken,
  parseTokenExpiry,
  QA_PREVIEW_TTL_MS,
} from '../../apps/http-api/server/routes/preview-auth.js';
import { archivePath, loadArchive, saveArchive } from './archive.js';
import type {
  CompanySandboxStore,
  PersistedSandboxRow,
  PersistedSandboxStatus,
} from '../../store/company-sandbox-store.js';
import type { CompanySandboxServicesStore } from '../../store/company-sandbox-services-store.js';
import type { CompanySessionEnvStore } from '../../store/company-session-env-store.js';

/**
 * Module-level binding of the persistence store. The SandboxManager
 * singleton itself is constructed lazily via `getSandboxManager()`, but
 * the DB-backed store comes from `createDeps()` at server boot — which
 * happens LATER. We use a setter + lazy getter so the manager works
 * even when the store is absent (tests, CLI, non-HTTP paths) and
 * transparently persists state when the store IS present.
 */
let sandboxStore: CompanySandboxStore | null = null;
let servicesStore: CompanySandboxServicesStore | null = null;
let envStore: CompanySessionEnvStore | null = null;

/**
 * QA preview-routing configuration injected at boot. Holds just the
 * port the http-api process is listening on so `syncManagedEnvs` can
 * compose `PLAYWRIGHT_BASE_URL_*` URLs that point at the proxy from
 * inside a sibling container. Optional `companyStore` lets the same
 * function gate QA env injection behind `hasQaPlaywrightSkill` without
 * importing the company store directly (preserves the dependency
 * direction).
 */
let qaPreviewConfig: {
  httpApiPort: number;
  hasQaPlaywrightSkill: (sessionId: number) => boolean;
} | null = null;

export function setCompanySandboxStore(store: CompanySandboxStore | null): void {
  sandboxStore = store;
}

export function setCompanySandboxServicesStore(
  store: CompanySandboxServicesStore | null,
): void {
  servicesStore = store;
}

export function setCompanySessionEnvStore(
  store: CompanySessionEnvStore | null,
): void {
  envStore = store;
}

/**
 * Wire the QA preview-URL routing config. Called from `server.ts` at
 * boot once `IndexerConfig` has been loaded and the company store is
 * available. When this is null (tests, CLI, non-HTTP paths) the
 * `PLAYWRIGHT_BASE_URL_*` family is silently skipped — sessions
 * without the `qa-playwright` skill don't pay the cost either way.
 */
export function setQaPreviewConfig(
  cfg: {
    httpApiPort: number;
    hasQaPlaywrightSkill: (sessionId: number) => boolean;
  } | null,
): void {
  qaPreviewConfig = cfg;
}

function getStore(): CompanySandboxStore | null {
  return sandboxStore;
}

function getServicesStore(): CompanySandboxServicesStore | null {
  return servicesStore;
}

/**
 * Should `destroyService` hard-delete the persisted row?
 *
 * True only for explicit user-driven removals. All other teardown
 * reasons (retry, abort, session-end, TTL reaper) are transient — the
 * project link in `company_session_projects` outlives the container,
 * so wiping the row would leave an orphaned project nobody can see
 * or recover from the UI.
 *
 * Transient cases instead patch `status='destroyed'` + keep the last
 * known `container_id` for audit; `GET /services` surfaces the row
 * as "orphaned" so the user can Retry or Remove it deliberately.
 */
function shouldHardDeleteService(reason: string): boolean {
  return reason === 'user-removed' || reason === 'user-removed-offline';
}

/**
 * Resolve shared env vars for a session. Returns an empty record when
 * the store isn't wired (tests, CLI paths) or the session id isn't
 * numeric. Used by both primary and secondary provision paths.
 */
function resolveSessionEnvs(sessionId: string): Record<string, string> {
  if (!envStore) return {};
  const numericId = Number(sessionId);
  if (!Number.isFinite(numericId)) return {};
  try {
    return envStore.asRecord(numericId);
  } catch {
    return {};
  }
}

/**
 * Parse a dotenv-style file body into key→value pairs. Minimal
 * implementation — supports `KEY=VALUE`, trims surrounding whitespace,
 * strips a single matching pair of `"`/`'` quotes from the value, and
 * skips blank/comment lines. Good enough for the one-shot import on
 * provision; complex cases (multiline values, variable expansion) are
 * explicitly out of scope.
 */
function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Drop an inline `# comment` when the value is unquoted.
    if (!(value.startsWith('"') || value.startsWith("'"))) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Best-effort import of an existing `.env` file sitting in a sandbox's
 * host workdir into `company_session_envs`. Silently no-ops when the
 * file is missing, the store isn't wired, the session id isn't
 * numeric, or the read fails for any reason — the provision must not
 * abort over env-import hiccups.
 *
 * Rows are written with `source: 'imported'` and `onlyIfAbsent: true`
 * so a user-managed value (set via the Env tab) always wins over the
 * checked-in default.
 */
function importDotEnvIntoStore(hostWorkdirMount: string, sessionId: string): void {
  if (!envStore) return;
  const numericId = Number(sessionId);
  if (!Number.isFinite(numericId)) return;
  const envPath = join(hostWorkdirMount, '.env');
  if (!existsSync(envPath)) return;
  try {
    const content = readFileSync(envPath, 'utf8');
    const pairs = parseDotEnv(content);
    for (const [key, value] of Object.entries(pairs)) {
      envStore.upsert(numericId, key, value, false, {
        source: 'imported',
        onlyIfAbsent: true,
      });
    }
  } catch (e) {
    console.warn(
      `[sandbox-manager] import .env for session ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Resolve the operator-configured public base URL used to absolutize
 * preview URLs in managed envs. Operators set this to whatever origin
 * the dashboard is reachable at — dev usually `http://localhost:5173`,
 * prod `https://mcp.example.com`. When unset we return `null` and the
 * caller falls back to emitting relative URLs.
 *
 * Precedence: `MCP_PUBLIC_URL` → `MCP_DASHBOARD_URL` → null.
 * Trailing slashes are stripped so `${base}${relative}` produces a
 * clean concatenation.
 */
function resolvePublicBase(): string | null {
  const raw = process.env.MCP_PUBLIC_URL ?? process.env.MCP_DASHBOARD_URL ?? '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed || null;
}

/**
 * Pure: validate that a workspace-relative path is safe for HTTP
 * callers to traverse. Rejects absolute paths, empty strings, and any
 * `..` segment that could climb out of the workdir. Normalises slashes.
 *
 * Exported is unnecessary — only used by the manager; tests can drive
 * it via `readWorkspaceFile` thrown errors.
 */
function ensureSafeRelPath(relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new Error('workspace path must be a non-empty string');
  }
  const normalised = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalised.startsWith('/')) {
    throw new Error('absolute paths are not allowed');
  }
  const parts = normalised.split('/');
  if (parts.some((p) => p === '..' || p === '.')) {
    throw new Error('relative path must not contain `..` or `.` segments');
  }
  // NUL bytes — unusual but a known shell-escape vector.
  if (normalised.includes('\0')) {
    throw new Error('path contains illegal NUL byte');
  }
  return parts.join('/');
}

/**
 * Prepend `base` to `relative` when `relative` is origin-less. Absolute
 * URLs pass through unchanged. Returns the original string verbatim
 * when no base is configured so managed envs degrade gracefully (the
 * iframe still works because it's same-origin; only external callers
 * need absolute URLs).
 */
function absolutize(relative: string, base: string | null): string {
  if (!relative) return relative;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(relative)) return relative;
  if (!base) return relative;
  return relative.startsWith('/') ? `${base}${relative}` : `${base}/${relative}`;
}

/**
 * Render a `.env` file body from a flat map — one line per key, values
 * lightly quoted when they contain whitespace or shell metacharacters.
 * Written into the workdir so dev-servers that auto-load `.env`
 * (vite, wrangler, node --env-file) see the values without a cold restart.
 */
function renderDotEnv(envs: Record<string, string>): string {
  const safeKey = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const lines: string[] = [
    '# Managed by MCP SandboxService — shared session env.',
    '# Regenerated on every provision + when agents run env_set/env_delete.',
  ];
  for (const [key, value] of Object.entries(envs)) {
    if (!safeKey.test(key)) continue;
    const needsQuote = /[\s"'`$\\]/.test(value) || value === '';
    const escaped = needsQuote
      ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`
      : value;
    lines.push(`${key}=${escaped}`);
  }
  return lines.join('\n') + '\n';
}

export interface SandboxManagerOptions {
  driver?: ISandboxDriver;
  allocator?: PortAllocator;
  /** Max concurrent sandboxes. Defaults to 10 (env: MCP_MAX_SANDBOXES). */
  maxSandboxes?: number;
  /** Idle time before auto-destroy. Defaults to 30 min (env: MCP_SANDBOX_IDLE_MS). */
  idleTtlMs?: number;
  /** Base image for Node-stack sandboxes. Defaults to `localhost/mcp-sandbox-node:20-py`. */
  nodeImage?: string;
  /** Container port the dev server binds to. Defaults to 5173 (Vite). */
  devServerPort?: number;
  /** Absolute container path used as workdir. Defaults to `/app`. */
  workdir?: string;
  /** Interval for `sandbox.stats` sampling. 0 disables. Default 15s. */
  statsIntervalMs?: number;
  /**
   * Build the public preview URL from `hostPort` + `sandboxId`. When the
   * API server proxies `/preview/:sessionId/*`, the URL is origin-
   * relative and this returns just the path. Override when running
   * behind a subdomain strategy.
   */
  buildPreviewUrl?: (sessionId: string, hostPort: number) => string;
}

const DEFAULT_MAX = 10;
const DEFAULT_IDLE_TTL = 30 * 60 * 1000;
const DEFAULT_NODE_IMAGE = 'mcp-sandbox-node:20-py';
const DEFAULT_DEV_PORT = 5173;
const DEFAULT_WORKDIR = '/app';

/**
 * Clean up per-session persistence state: the bind-mount host dir AND
 * the named `node_modules` volume. Invoked from the DELETE /sessions
 * handler after the container has already been destroyed. Best effort
 * — failures are logged, not thrown (session deletion should not be
 * blocked by stale persistence artifacts).
 */
export async function cleanupSessionPersistence(sessionId: string): Promise<void> {
  // 1. Host workdir dir.
  const hostDir = resolveHostWorkdirMount(sessionId);
  if (hostDir && existsSync(hostDir)) {
    try {
      rmSync(hostDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(
        `[sandbox-manager] remove host workdir ${hostDir} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 2. Named node_modules volume. Route through the active CLI driver
  //    when available — falls back to `docker`/`podman` discovery via
  //    env. Silently no-ops when the volume doesn't exist.
  const volName = nodeModulesVolumeFor(sessionId);
  const binary =
    process.env.MCP_SANDBOX_RUNTIME === 'podman' ? 'podman' : 'docker';
  await new Promise<void>((resolve) => {
    const child = spawnChild(binary, ['volume', 'rm', '-f', volName], {
      stdio: 'ignore',
    });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

/**
 * Resolve the host directory that's bind-mounted onto the sandbox workdir.
 * Default layout: `<cwd>/data/virtual-projects/<sessionId>`. Operators can
 * relocate via `MCP_SANDBOX_WORKDIR_HOST_DIR` (absolute path — sessionId
 * is appended as a subdir).
 *
 * Returns `null` when persistence via bind-mount is explicitly disabled
 * (`MCP_SANDBOX_BIND_MOUNT=0`), preserving the legacy ephemeral-fs
 * behavior for environments where bind mounts are unavailable (e.g.
 * remote docker host with no shared FS).
 */
function resolveHostWorkdirMount(sessionId: string): string | null {
  if (process.env.MCP_SANDBOX_BIND_MOUNT === '0') return null;
  const base =
    process.env.MCP_SANDBOX_WORKDIR_HOST_DIR ??
    resolvePath(process.cwd(), 'data', 'virtual-projects');
  return join(base, String(sessionId));
}

/** Deterministic name for the per-session `node_modules` named volume. */
function nodeModulesVolumeFor(sessionId: string): string {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
  return `mcp-sbx-nm-${safe}`;
}

/** True when `dir` exists and contains at least a `package.json`. */
function hasInitializedWorkdir(dir: string): boolean {
  try {
    const entries = readdirSync(dir);
    return entries.includes('package.json');
  } catch {
    return false;
  }
}

export interface ProvisionRequest {
  sessionId: string;
  stack: SandboxStack;
  signal?: AbortSignal;
  /**
   * Optional archive to restore into the workdir after container start,
   * in place of running the scaffolder. Used by `SandboxService` when
   * resuming a session that was archived at teardown.
   */
  restoreArchive?: Buffer;
  /**
   * When true, a pre-existing sandbox record in `error` state for this
   * session is torn down first and recreated fresh. Normal (non-retry)
   * calls just return the existing record. The HTTP `POST /sandbox`
   * route sets this flag when the UI's "Retry" button fires.
   */
  retry?: boolean;
  /**
   * Per-session override of the CPU/memory/pids ceiling. Any field left
   * `undefined` falls back to `DEFAULT_SANDBOX_LIMITS` (which itself
   * respects `MCP_SANDBOX_*` env vars). Supplied by `SandboxService`
   * after reading `CompanySession.config_json.builder.limits`.
   */
  limits?: Partial<import('./types.js').SandboxLimits>;
  /**
   * Absolute host path to bind-mount onto the primary workdir. When
   * provided, the manager skips its default sessionId-based layout
   * (`data/virtual-projects/<sessionId>`) and uses this instead — so
   * the sandbox writes to the SAME directory the session's virtual
   * project row (`_builder_<uuid>`) points at. The HTTP `/sandbox`
   * route and `SandboxService.provisionIfNeeded` look this up from
   * the linked project's `root_path` before calling provision.
   */
  hostWorkdirMount?: string;
  /**
   * When true the session has at least one role with the `qa-playwright`
   * skill, so:
   *   - the scaffolder writes a Playwright client config + reporter
   *     into the project container (no browser install — the client
   *     just connects);
   *   - the caller (SandboxService) provisions a separate
   *     `playwright-sidecar` container running
   *     `mcr.microsoft.com/playwright:...` + `npx playwright run-server`,
   *     attached to the same docker network, and injects
   *     `PLAYWRIGHT_WS_ENDPOINT` into the project container's env.
   *
   * Architecturally: project container stays lean (~592 MB), browser
   * lives in the sidecar (~2 GB pulled once + cached). The QA agent
   * never installs anything browser-related — the env var tells it
   * where to connect, and the skill v2.0.0 prompt forbids any local
   * install attempts.
   *
   * `SandboxService.provisionIfNeeded` derives this from
   * `config_json.role_assignments` (auto-detect via `qa-playwright`
   * skill). The legacy env var `MCP_SANDBOX_INCLUDE_E2E=1` still works
   * as a global override for tests.
   */
  includeE2e?: boolean;
}

/**
 * Request to stand up a SECONDARY container alongside the primary
 * sandbox of a session. Used for multi-microservice sessions
 * (frontend + worker + php). The primary sandbox must already exist
 * — `SandboxManager.provisionAdditionalService` refuses otherwise.
 */
export interface ProvisionServiceRequest {
  sessionId: string;
  /** Stable token — also the in-network hostname. */
  serviceId: string;
  /** Free-form stack key (validated by the scaffolder registry). */
  stack: SandboxStack;
  /** Display label shown in the dashboard; falls back to serviceId. */
  name?: string;
  limits?: Partial<import('./types.js').SandboxLimits>;
  signal?: AbortSignal;
  /**
   * Absolute host path to bind-mount onto the service workdir. When the
   * route layer creates a real `projects` row for this service (so it
   * shows up in the dashboard's Projects list and can be indexed), it
   * passes the project's `root_path` here. The manager skips its own
   * under-session subdir layout and uses this instead — one host dir
   * per service, flat and indexable, NOT nested inside the session's
   * primary workspace.
   */
  hostWorkdirMount?: string;
  /**
   * When `true`, destroy any pre-existing service with the same id
   * (including ones currently `ready`) before provisioning. Used by
   * the retry endpoint so the user can forcibly rebuild a service
   * whose container died silently, without having to delete it first.
   */
  forceRecreate?: boolean;
}

export class SandboxManager {
  private readonly emitter = new EventEmitter();
  private readonly allocator: PortAllocator;
  private readonly sandboxes = new Map<string, Sandbox>();
  /**
   * Secondary containers (`service_id !== 'main'`) keyed by composite
   * `sessionId:serviceId`. Kept in a separate map so the primary-
   * container paths (reconcile, reap, TTL) don't accidentally touch
   * services. Service lifecycle is driven by explicit REST calls.
   */
  private readonly services = new Map<string, Sandbox>();
  private driver: ISandboxDriver | null;
  private readonly maxSandboxes: number;
  private readonly idleTtlMs: number;
  /** Soft idle TTL — pause (podman stop) without destroying. */
  private readonly pauseTtlMs: number;
  /** Hard idle TTL — promote paused sandbox to destroyed + archive. */
  private readonly destroyAfterPauseMs: number;
  private readonly nodeImage: string;
  private readonly devServerPort: number;
  private readonly workdir: string;
  private readonly buildPreviewUrl: (sessionId: string, hostPort: number) => string;
  private reaperTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private readonly statsIntervalMs: number;
  private shuttingDown = false;

  constructor(options: SandboxManagerOptions = {}) {
    this.driver = options.driver ?? null;
    this.allocator = options.allocator ?? defaultPortAllocator();
    this.maxSandboxes = options.maxSandboxes ?? Number(process.env.MCP_MAX_SANDBOXES ?? DEFAULT_MAX);
    // Legacy knob: if MCP_SANDBOX_IDLE_MS is set, use it as the soft
    // pause TTL so operators upgrading from the old destroy-on-idle
    // behavior keep reasonable defaults.
    this.idleTtlMs = options.idleTtlMs ?? Number(process.env.MCP_SANDBOX_IDLE_MS ?? DEFAULT_IDLE_TTL);
    this.pauseTtlMs = Number(process.env.MCP_SANDBOX_PAUSE_AFTER_MS ?? this.idleTtlMs);
    this.destroyAfterPauseMs = Number(
      process.env.MCP_SANDBOX_DESTROY_AFTER_PAUSE_MS ?? 24 * 60 * 60 * 1000, // 24h
    );
    this.nodeImage = options.nodeImage ?? DEFAULT_NODE_IMAGE;
    this.devServerPort = options.devServerPort ?? DEFAULT_DEV_PORT;
    this.workdir = options.workdir ?? DEFAULT_WORKDIR;
    this.buildPreviewUrl = options.buildPreviewUrl ?? defaultPreviewUrl;
    this.statsIntervalMs =
      options.statsIntervalMs ?? Number(process.env.MCP_SANDBOX_STATS_MS ?? 15_000);
    this.startReaper();
    this.startStatsSampler();
    this.installShutdownHandlers();
  }

  // ──────────────────────────────────────────────────────────── observers

  subscribe(observer: SandboxObserver): () => void {
    const wrapped = (event: SandboxEvent) => observer(event);
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  private emit(event: SandboxEvent): void {
    this.emitter.emit('event', event);
  }

  // ────────────────────────────────────────────────────────────── queries

  get(sessionId: string): Sandbox | undefined {
    return this.sandboxes.get(sessionId);
  }

  list(): Sandbox[] {
    return [...this.sandboxes.values()];
  }

  // ────────────────────────────────────────────────── workspace I/O
  // Thin wrappers around `driver.readFile` / `driver.writeFile` /
  // `driver.exec` exposed at the manager surface so HTTP routes can
  // serve files from the container without grabbing the private
  // driver handle. Paths are resolved RELATIVE to the sandbox's
  // workdir; absolute paths and `..` traversal are rejected here so
  // callers don't need to repeat the validation.

  /**
   * Read a workspace-relative text file. Returns `null` when the file
   * doesn't exist (driver-level "ENOENT" surfaces as a thrown error;
   * we translate it). Throws on any other I/O failure or when the
   * sandbox is missing.
   */
  async readWorkspaceFile(sessionId: string, relPath: string): Promise<string | null> {
    const { driver, sb, abs } = this.resolveWorkspacePath(sessionId, relPath);
    try {
      return await driver.readFile(sb.containerId, abs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such file|ENOENT|not found/i.test(msg)) return null;
      throw e;
    }
  }

  /** Write a workspace-relative text file (creates parents). */
  async writeWorkspaceFile(sessionId: string, relPath: string, data: string): Promise<void> {
    const { driver, sb, abs } = this.resolveWorkspacePath(sessionId, relPath);
    await driver.writeFile(sb.containerId, abs, data, { recursive: true });
  }

  /**
   * Stream a workspace-relative binary file out as a Buffer via base64
   * transit. We pipe through `base64` because `driver.readFile` is
   * utf-8-only — Playwright trace.zip files would be corrupted by a
   * naive text read. The container ships `coreutils` so `base64`
   * is universally available.
   *
   * @throws when the file is missing or larger than `maxBytes`.
   */
  async readWorkspaceFileBuffer(
    sessionId: string,
    relPath: string,
    opts?: { maxBytes?: number },
  ): Promise<Buffer> {
    const maxBytes = opts?.maxBytes ?? 25 * 1024 * 1024; // 25 MiB default
    const { driver, sb, abs } = this.resolveWorkspacePath(sessionId, relPath);
    // Cheap size guard via `wc -c` before pulling bytes; avoids loading
    // a runaway file into memory only to reject it.
    const sizeProbe = await driver.exec(sb.containerId, `wc -c < "${abs}"`, {
      cwd: undefined,
      timeoutMs: 5_000,
    });
    if (sizeProbe.exitCode !== 0) {
      throw new Error(`workspace file not readable: ${sizeProbe.stderr || sizeProbe.stdout}`);
    }
    const size = Number(sizeProbe.stdout.trim());
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(`file ${relPath} is ${size} bytes, max ${maxBytes}`);
    }
    const b64 = await driver.exec(sb.containerId, `base64 -w0 < "${abs}"`, {
      cwd: undefined,
      timeoutMs: 30_000,
      maxOutputBytes: Math.ceil(maxBytes * 1.4) + 1024, // base64 inflation
    });
    if (b64.exitCode !== 0) {
      throw new Error(`base64 read failed: ${b64.stderr || b64.stdout}`);
    }
    return Buffer.from(b64.stdout.trim(), 'base64');
  }

  /**
   * Multi-service variant: same shape as `readWorkspaceFileBuffer` but
   * resolves the sandbox via `(sessionId, serviceId)`. When `serviceId`
   * is `undefined` or `'main'` we fall through to the primary container,
   * so callers don't have to branch.
   *
   * Used by the QA artifact route to serve screenshots/videos/HTML
   * report from any microservice's workdir without exposing the
   * primary-only `readWorkspaceFileBuffer` to that path.
   */
  async readWorkspaceFileBufferOnService(
    sessionId: string,
    serviceId: string | undefined,
    relPath: string,
    opts?: { maxBytes?: number },
  ): Promise<Buffer> {
    const isPrimary = !serviceId || serviceId === 'main';
    if (isPrimary) return this.readWorkspaceFileBuffer(sessionId, relPath, opts);

    const maxBytes = opts?.maxBytes ?? 25 * 1024 * 1024;
    const { driver, sb, abs } = this.resolveServiceWorkspacePath(sessionId, serviceId, relPath);
    const sizeProbe = await driver.exec(sb.containerId, `wc -c < "${abs}"`, {
      cwd: undefined,
      timeoutMs: 5_000,
    });
    if (sizeProbe.exitCode !== 0) {
      throw new Error(`workspace file not readable: ${sizeProbe.stderr || sizeProbe.stdout}`);
    }
    const size = Number(sizeProbe.stdout.trim());
    if (Number.isFinite(size) && size > maxBytes) {
      throw new Error(`file ${relPath} is ${size} bytes, max ${maxBytes}`);
    }
    const b64 = await driver.exec(sb.containerId, `base64 -w0 < "${abs}"`, {
      cwd: undefined,
      timeoutMs: 30_000,
      maxOutputBytes: Math.ceil(maxBytes * 1.4) + 1024,
    });
    if (b64.exitCode !== 0) {
      throw new Error(`base64 read failed: ${b64.stderr || b64.stdout}`);
    }
    return Buffer.from(b64.stdout.trim(), 'base64');
  }

  /**
   * v4.5 — list every regular file under a workspace-relative directory
   * inside the sandbox, returning their paths relative to that root.
   * Powers the QA report-persistence helper, which needs to mirror
   * `playwright-report/` and `test-results/` to the host disk before
   * the sandbox is destroyed.
   *
   * Implementation: a single `find -type f -printf '%P\n'` call. The
   * container ships GNU coreutils so `-printf` is universally available;
   * BusyBox `find` is NOT used in the project images. Returns an empty
   * array when the directory does not exist (e.g. a run that never
   * produced reports). Does NOT recurse into symlinks.
   */
  async listWorkspaceFilesOnService(
    sessionId: string,
    serviceId: string | undefined,
    relDir: string,
  ): Promise<string[]> {
    const isPrimary = !serviceId || serviceId === 'main';
    const { driver, sb, abs } = isPrimary
      ? this.resolveWorkspacePath(sessionId, relDir)
      : this.resolveServiceWorkspacePath(sessionId, serviceId, relDir);

    // Probe existence first — `find` on a missing dir would emit to
    // stderr with exit 1, which is indistinguishable from a real failure
    // to read a known file. A test on the directory makes the
    // not-yet-produced case explicit + cheap.
    const probe = await driver.exec(sb.containerId, `[ -d "${abs}" ] && echo y || echo n`, {
      cwd: undefined,
      timeoutMs: 5_000,
    });
    if (probe.exitCode !== 0 || probe.stdout.trim() !== 'y') return [];

    const list = await driver.exec(sb.containerId, `find "${abs}" -type f -printf '%P\\n'`, {
      cwd: undefined,
      timeoutMs: 30_000,
      maxOutputBytes: 4 * 1024 * 1024, // 4 MiB of paths is enough for tens of thousands of files
    });
    if (list.exitCode !== 0) {
      throw new Error(`listWorkspaceFilesOnService failed: ${list.stderr || list.stdout}`);
    }
    return list.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /**
   * v4.5 — recursively delete a workspace-relative directory. Used by
   * `restoreQaWorkspace` to clear `tests/e2e/test-results/` and
   * `tests/e2e/playwright-report/` between QA runs so the operator's
   * disk doesn't grow unboundedly. Best-effort: missing dirs are NOT
   * an error.
   */
  async removeWorkspaceDirOnService(
    sessionId: string,
    serviceId: string | undefined,
    relDir: string,
  ): Promise<void> {
    const isPrimary = !serviceId || serviceId === 'main';
    const { driver, sb, abs } = isPrimary
      ? this.resolveWorkspacePath(sessionId, relDir)
      : this.resolveServiceWorkspacePath(sessionId, serviceId, relDir);
    // Refuse to wipe an empty / root-equivalent path. The
    // ensureSafeRelPath validator already rejects '.', '..', and
    // absolute paths, so the only way `abs` could equal the workdir
    // root is if `relDir` was an empty string.
    if (!relDir || relDir.trim() === '') return;
    const r = await driver.exec(sb.containerId, `rm -rf "${abs}"`, {
      cwd: undefined,
      timeoutMs: 30_000,
    });
    if (r.exitCode !== 0 && !/no such file|not found/i.test(r.stderr || '')) {
      throw new Error(`removeWorkspaceDirOnService failed: ${r.stderr || r.stdout}`);
    }
  }

  /**
   * Multi-service variant of `readWorkspaceFile` (text). Same fall-through
   * to primary when `serviceId` is missing / 'main'.
   */
  async readWorkspaceFileOnService(
    sessionId: string,
    serviceId: string | undefined,
    relPath: string,
  ): Promise<string | null> {
    const isPrimary = !serviceId || serviceId === 'main';
    if (isPrimary) return this.readWorkspaceFile(sessionId, relPath);
    const { driver, sb, abs } = this.resolveServiceWorkspacePath(sessionId, serviceId, relPath);
    try {
      return await driver.readFile(sb.containerId, abs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such file|ENOENT|not found/i.test(msg)) return null;
      throw e;
    }
  }

  private resolveServiceWorkspacePath(
    sessionId: string,
    serviceId: string,
    relPath: string,
  ): { driver: ISandboxDriver; sb: Sandbox; abs: string } {
    if (!this.driver) throw new Error('SandboxManager has no driver wired');
    const sb = this.getService(sessionId, serviceId);
    if (!sb) throw new Error(`No sandbox for session ${sessionId} service ${serviceId}`);
    const safe = ensureSafeRelPath(relPath);
    const base = sb.workdir.replace(/\/+$/, '');
    return { driver: this.driver, sb, abs: `${base}/${safe}` };
  }

  /**
   * Pure(ish) helper: validate a workspace-relative path and resolve
   * it against the sandbox's container workdir. Rejects absolute paths
   * and any `..` segment so HTTP callers can't escape the workspace.
   */
  private resolveWorkspacePath(
    sessionId: string,
    relPath: string,
  ): { driver: ISandboxDriver; sb: Sandbox; abs: string } {
    if (!this.driver) throw new Error('SandboxManager has no driver wired');
    const sb = this.sandboxes.get(sessionId);
    if (!sb) throw new Error(`No sandbox for session ${sessionId}`);
    const safe = ensureSafeRelPath(relPath);
    const base = sb.workdir.replace(/\/+$/, '');
    return { driver: this.driver, sb, abs: `${base}/${safe}` };
  }

  // ───────────────────────────────────────────────────── services (multi)

  private serviceKey(sessionId: string, serviceId: string): string {
    return `${sessionId}:${serviceId}`;
  }

  /** In-memory lookup for an additional service of a session. */
  getService(sessionId: string, serviceId: string): Sandbox | undefined {
    return this.services.get(this.serviceKey(sessionId, serviceId));
  }

  /**
   * Resolve the CURRENT containerId for a session's primary sandbox
   * (serviceId unset or 'main') or one of its secondary services.
   * Returns `null` when the manager has no live record — callers use
   * this as the source of truth to avoid stale ids captured at spawn
   * time. When a container is destroyed+recreated (retry, orphan
   * recovery), this reflects the new id on the next call without
   * requiring listeners or rehydration in consumers.
   */
  resolveContainerId(sessionId: string, serviceId?: string | null): string | null {
    if (!serviceId || serviceId === 'main') {
      return this.sandboxes.get(sessionId)?.containerId ?? null;
    }
    return this.services.get(this.serviceKey(sessionId, serviceId))?.containerId ?? null;
  }

  /** Every additional service (primary excluded) belonging to a session. */
  listServices(sessionId: string): Sandbox[] {
    const prefix = `${sessionId}:`;
    const out: Sandbox[] = [];
    for (const [key, sb] of this.services.entries()) {
      if (key.startsWith(prefix)) out.push(sb);
    }
    return out;
  }

  /**
   * Like `listServices` but pairs each sandbox with its `serviceId`
   * (recovered from the map key). Consumers that bind services by id
   * — e.g. per-session `SandboxService.serviceBindings` hydration after
   * a server restart — need this to avoid a DB round-trip.
   */
  listServicesWithIds(sessionId: string): Array<{ serviceId: string; sandbox: Sandbox }> {
    const prefix = `${sessionId}:`;
    const out: Array<{ serviceId: string; sandbox: Sandbox }> = [];
    for (const [key, sb] of this.services.entries()) {
      if (!key.startsWith(prefix)) continue;
      const serviceId = key.slice(prefix.length);
      out.push({ serviceId, sandbox: sb });
    }
    return out;
  }

  /**
   * Stand up a secondary container for a session that already has a
   * primary sandbox. Three side-effects beyond the normal provision
   * path:
   *   1. Ensures the session's shared docker network exists, attaching
   *      the PRIMARY container to it on first call (idempotent).
   *   2. Creates the new container with `isolation.network` pointing at
   *      that network and an alias equal to `serviceId`, so other
   *      services can `fetch('http://<serviceId>/…')`.
   *   3. Persists the row into `company_sandbox_services` (migration 035)
   *      — NOT the primary `company_sandboxes` table.
   *
   * Idempotent on `serviceId`: a second call with the same id returns
   * the existing record.
   */
  async provisionAdditionalService(req: ProvisionServiceRequest): Promise<Sandbox> {
    if (req.serviceId === 'main') {
      throw new Error(`service_id 'main' is reserved for the primary sandbox`);
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(req.serviceId)) {
      throw new Error(
        `Invalid service_id '${req.serviceId}' — use lowercase letters, digits, hyphen; ≤32 chars`,
      );
    }

    const primary = this.sandboxes.get(req.sessionId);
    if (!primary) {
      throw new Error(
        `Cannot add service '${req.serviceId}' — session ${req.sessionId} has no primary sandbox`,
      );
    }

    const existing = this.getService(req.sessionId, req.serviceId);
    if (existing) {
      if (!req.forceRecreate) return existing;
      // Force path: tear down the current container (logs already
      // captured by whatever triggered the retry) and fall through
      // to a fresh provision below. Ignore errors — if destroy races
      // or the container is already gone, we still want to provision.
      try {
        await this.destroyService(req.sessionId, req.serviceId, 'retry');
      } catch (e) {
        console.warn(
          `[sandbox-manager] forceRecreate destroy ${req.sessionId}:${req.serviceId} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    if (this.sandboxes.size + this.services.size >= this.maxSandboxes) {
      throw new Error(
        `Too many concurrent sandboxes (${this.sandboxes.size + this.services.size}/${this.maxSandboxes}).`,
      );
    }

    const driver = await this.resolveDriverOnce();

    // Ensure shared network; best-effort. If it fails we still proceed
    // on the default bridge — services are reachable via published
    // ports even without the alias.
    const networkName = await ensureSessionNetwork(req.sessionId);
    if (networkName && primary.containerId) {
      await attachContainerToSessionNetwork(req.sessionId, primary.containerId, 'main');
    }

    const hostPort = await this.allocator.acquire();
    // Secondary services get a dedicated URL shape the preview proxy
    // route `/preview/:sessionId/_svc/:serviceId/*` matches. Using the
    // same `/preview/:sessionId/` shape as primary caused a slash-in-
    // sessionId mess (the router saw `sessionId="58%2Fapi"` and the
    // HMAC cookie minted for `58` rejected with "token invalid").
    const previewUrl = `/preview/${encodeURIComponent(req.sessionId)}/_svc/${encodeURIComponent(req.serviceId)}/`;
    const seedLimits = { ...DEFAULT_SANDBOX_LIMITS, ...(req.limits ?? {}) };
    const serviceSandboxId = `${req.sessionId}:${req.serviceId}`;

    const seed: Sandbox = {
      id: serviceSandboxId,
      containerId: '',
      runtime: driver.runtime,
      stack: req.stack,
      hostPort,
      workdir: this.workdir,
      previewUrl,
      limits: seedLimits,
      status: 'pending',
      step: 'queued',
      recentLogs: [],
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
      // Persist the caller-supplied (UUID-based) workdir mount NOW so
      // that if the very first `driver.create` fails, the error row
      // still points at the correct host dir. Otherwise retry can't
      // recover the original UUID path from the DB — it would fall
      // back to the legacy serviceId-based layout.
      hostWorkdirMount: req.hostWorkdirMount,
    };
    this.services.set(this.serviceKey(req.sessionId, req.serviceId), seed);
    this.persistService(req.sessionId, req.serviceId, req.name ?? req.serviceId, seed, 'provisioning');
    this.emit({ kind: 'provisioning', sandboxId: serviceSandboxId, stack: req.stack });

    try {
      seed.status = 'provisioning';

      const isolation = {
        ...DEFAULT_SANDBOX_ISOLATION,
        network: networkName ?? DEFAULT_SANDBOX_ISOLATION.network,
      };
      const limits = { ...DEFAULT_SANDBOX_LIMITS, ...(req.limits ?? {}) };

      // Bind-mount resolution prefers a caller-supplied absolute path —
      // this is how the HTTP route injects a real projects.root_path so
      // the microservice shows up as its own project in the dashboard.
      // Falls back to the legacy per-session subdir when no override
      // (e.g. a direct manager call from tests / scripts).
      const perServiceHostRoot = resolveHostWorkdirMount(req.sessionId);
      const hostWorkdirMount =
        req.hostWorkdirMount ??
        (perServiceHostRoot ? join(perServiceHostRoot, req.serviceId) : null);
      const nodeModulesVolumeName = hostWorkdirMount
        ? `${nodeModulesVolumeFor(req.sessionId)}-${req.serviceId}`
        : undefined;
      if (hostWorkdirMount) {
        try {
          mkdirSync(hostWorkdirMount, { recursive: true });
        } catch (e) {
          throw new Error(
            `Failed to prepare host workdir ${hostWorkdirMount}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        // Microservices can ship their own `.env` in the service
        // subdir (e.g. `data/virtual-projects/<session>/api/.env`).
        // Import it into the shared session envs so siblings see the
        // values too — every container already receives the merged
        // shared envs on start.
        importDotEnvIntoStore(hostWorkdirMount, req.sessionId);
      }

      const sharedEnvs = resolveSessionEnvs(req.sessionId);
      const { containerId } = await driver.create({
        sandboxId: serviceSandboxId,
        image: this.nodeImage,
        stack: req.stack,
        workdir: this.workdir,
        hostPort,
        containerPort: this.devServerPort,
        limits,
        isolation,
        env: Object.keys(sharedEnvs).length > 0 ? sharedEnvs : undefined,
        hostWorkdirMount: hostWorkdirMount ?? undefined,
        nodeModulesVolumeName,
      });
      seed.containerId = containerId;
      seed.hostWorkdirMount = hostWorkdirMount ?? undefined;
      seed.nodeModulesVolumeName = nodeModulesVolumeName;

      await this.prepareWorkdir(driver, containerId, this.workdir, isolation.user);
      if (Object.keys(sharedEnvs).length > 0) {
        try {
          await driver.writeFile(
            containerId,
            `${this.workdir}/.env`,
            renderDotEnv(sharedEnvs),
            { recursive: true },
          );
        } catch (e) {
          this.appendLog(
            seed,
            'info',
            `(non-fatal) write .env failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      const hostWorkdirPopulated =
        !!hostWorkdirMount && hasInitializedWorkdir(hostWorkdirMount);

      if (hostWorkdirPopulated) {
        this.recordStep(seed, 'starting-dev-server', 'Resuming persisted workdir…');
        await this.relaunchDevServer(driver, containerId, this.workdir, req.signal, req.stack);
      } else {
        const scaffolder = getScaffolder(req.stack);
        await scaffolder.scaffold({
          sandboxId: serviceSandboxId,
          containerId,
          workdir: this.workdir,
          devServerPort: this.devServerPort,
          previewUrl,
          previewPathPrefix: previewPathPrefixOf(previewUrl),
          driver,
          signal: req.signal,
          emit: (e) => {
            if (e.kind === 'step') this.recordStep(seed, e.step, e.message);
            else if (e.kind === 'log') this.appendLog(seed, 'info', e.chunk);
            this.emit(e);
          },
        });
      }

      seed.status = 'ready';
      seed.step = 'ready';
      seed.lastAccessAt = Date.now();
      this.persistService(req.sessionId, req.serviceId, req.name ?? req.serviceId, seed, 'running');
      this.emit({ kind: 'ready', sandboxId: serviceSandboxId, previewUrl });
      // Refresh managed envs so the new service's PREVIEW_URL_* entry
      // lands in the DB and the next .env sync distributes it.
      this.syncManagedEnvs(req.sessionId);
      void this.syncEnvsToAllContainers(req.sessionId).catch(() => void 0);
      return seed;
    } catch (e) {
      const baseMessage = e instanceof Error ? e.message : String(e);
      // Before we destroy the failed container, grab whatever podman
      // saw: exit code, OOM flag, runtime error, last stdout/stderr
      // lines. Otherwise the user sees "provision failed" with no
      // hint why podman came up and died seconds later.
      const diagnostic = seed.containerId
        ? await this.captureContainerDiagnostic(driver, seed.containerId)
        : '';
      const message = diagnostic ? `${baseMessage}\n\n${diagnostic}` : baseMessage;
      seed.status = 'error';
      seed.step = 'error';
      seed.error = message;
      if (diagnostic) this.appendLog(seed, 'error', diagnostic);
      this.persistService(req.sessionId, req.serviceId, req.name ?? req.serviceId, seed, 'error');
      this.emit({ kind: 'error', sandboxId: serviceSandboxId, message });
      if (seed.containerId) {
        try { await driver.destroy(seed.containerId); } catch { /* logged */ }
      }
      throw new Error(message);
    }
  }

  /**
   * Pull a human-readable post-mortem from the runtime for a container
   * that is about to be (or has just been) destroyed. Best-effort: a
   * failure here is never surfaced — the caller is already in an error
   * path and we don't want to mask the real cause.
   *
   * Output shape (example):
   *   Container state: exitCode=137 oomKilled=true error="" finishedAt=...
   *   --- last logs ---
   *   npm ERR! code ENOSPC
   *   ...
   */
  private async captureContainerDiagnostic(
    driver: ISandboxDriver,
    containerId: string,
  ): Promise<string> {
    try {
      const [state, logs] = await Promise.all([
        driver.getContainerState(containerId).catch(() => null),
        driver.getContainerLogs(containerId, 100).catch(() => ''),
      ]);
      const parts: string[] = [];
      if (state) {
        parts.push(
          `Container state: exitCode=${state.exitCode ?? 'null'} ` +
            `oomKilled=${state.oomKilled} ` +
            (state.error ? `error=${JSON.stringify(state.error)} ` : '') +
            (state.finishedAt ? `finishedAt=${state.finishedAt}` : ''),
        );
      }
      if (logs) parts.push(`--- last logs ---\n${logs}`);
      return parts.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Refresh the "managed" env vars — auto-populated keys agents can
   * rely on without hardcoding anything. Two families:
   *
   *   PREVIEW_URL_*   — ABSOLUTE public URL for the browser / external
   *                     tools (goes through the dashboard proxy).
   *                     Resolved from `MCP_PUBLIC_URL` (operator-set)
   *                     or falls back to the host origin + the sandbox's
   *                     relative preview path. Example:
   *                       `http://localhost:5173/preview/58/`
   *                       `https://mcp.example.com/preview/58/api/`
   *                     Use these when the agent's code runs in a user
   *                     browser context or talks to an external caller.
   *
   *   SERVICE_URL_*   — INTERNAL docker network URL (container-to-
   *                     container). Each sandbox service is reachable
   *                     from its siblings by its `service_id` hostname
   *                     on the shared network port. Example:
   *                       `http://api:8080` (from any service's view)
   *                     Use these when the agent writes code inside
   *                     one container that fetches another (backend
   *                     calls another backend, SSR in frontend hitting
   *                     the API directly, etc).
   *
   * Keys are derived from service id: `main` for the primary, then
   * uppercased + non-alphanumeric → `_`. Idempotent: existing user
   * envs outside these prefixes are untouched; managed keys from
   * removed services are pruned.
   */
  syncManagedEnvs(sessionId: string): void {
    if (!envStore) return;
    const numericId = Number(sessionId);
    if (!Number.isFinite(numericId)) return;

    const desired = new Map<string, string>();
    const desiredSecret = new Set<string>();
    const publicBase = resolvePublicBase();

    // QA preview routing (v4.3) — gated by both the per-process config
    // (set at boot) AND the session's role assignments having the
    // `qa-playwright` skill. When either is missing we silently skip
    // the family so non-QA sessions don't pay the cost.
    const qaEnabled =
      qaPreviewConfig != null &&
      qaPreviewConfig.hasQaPlaywrightSkill(numericId);
    const qaRuntime = getResolvedRuntime();

    const addEntry = (idUpper: string, sb: Sandbox): void => {
      if (sb.previewUrl) {
        desired.set(`PREVIEW_URL_${idUpper}`, absolutize(sb.previewUrl, publicBase));
      }
      // Internal docker network: siblings address each other by
      // service_id hostname on the CONTAINER's dev-server port (not
      // the host-mapped port — the shared network is inside dockerd).
      const hostname = idUpper === 'MAIN' ? 'main' : idUpper.toLowerCase();
      desired.set(`SERVICE_URL_${idUpper}`, `http://${hostname}:${this.devServerPort}`);

      // QA preview URL through the http-api proxy, reachable from
      // sibling containers on different networks (the Chrome Service).
      // Each service gets its own entry; primary also gets the
      // unsuffixed alias `PLAYWRIGHT_BASE_URL` for the default Playwright
      // `baseURL` env-var convention.
      if (qaEnabled && sb.previewUrl) {
        const previewPath = previewPathPrefixOf(sb.previewUrl);
        const url = buildQaPreviewBaseUrl({
          httpApiPort: qaPreviewConfig!.httpApiPort,
          runtime: qaRuntime,
          previewPath,
        });
        desired.set(`PLAYWRIGHT_BASE_URL_${idUpper}`, url);
        if (idUpper === 'MAIN') desired.set('PLAYWRIGHT_BASE_URL', url);
      }
    };

    const primary = this.sandboxes.get(sessionId);
    if (primary) addEntry('MAIN', primary);
    for (const svc of this.listServices(sessionId)) {
      const svcId = svc.id.split(':')[1] ?? '';
      if (!svcId) continue;
      const safe = svcId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
      addEntry(safe, svc);
    }

    // QA cookie: long-lived HMAC token persisted as `MCP_PREVIEW_COOKIE`.
    // Re-mint when missing OR token has <7 days of headroom — verifying
    // long before expiry so an in-flight Playwright run never hits 401.
    if (qaEnabled) {
      try {
        const existing = envStore
          .list(numericId)
          .find((r) => r.key === 'MCP_PREVIEW_COOKIE');
        const exp = parseTokenExpiry(existing?.value);
        const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
        const stale = !exp || exp - Date.now() < REFRESH_THRESHOLD_MS;
        const value = stale
          ? mintPreviewToken(String(numericId), QA_PREVIEW_TTL_MS).value
          : existing!.value;
        desired.set('MCP_PREVIEW_COOKIE', value);
        desiredSecret.add('MCP_PREVIEW_COOKIE');
      } catch (e) {
        console.warn(
          `[sandbox-manager] mint preview cookie ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    try {
      for (const [key, value] of desired) {
        const isSecret = desiredSecret.has(key);
        envStore.upsert(numericId, key, value, isSecret, { source: 'auto' });
      }
      for (const row of envStore.list(numericId)) {
        const isManaged =
          row.key.startsWith('PREVIEW_URL_') ||
          row.key.startsWith('SERVICE_URL_') ||
          row.key.startsWith('PLAYWRIGHT_BASE_URL_') ||
          row.key === 'PLAYWRIGHT_BASE_URL' ||
          row.key === 'MCP_PREVIEW_COOKIE';
        if (isManaged && !desired.has(row.key)) {
          envStore.delete(numericId, row.key);
        }
      }
    } catch (e) {
      console.warn(
        `[sandbox-manager] syncManagedEnvs ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Rewrite `/app/.env` in every live container of a session (primary
   * + services) using the current env store. Called by the REST /envs
   * routes after a user edit so running dev-servers pick up the new
   * values on their next file-watch tick (vite and wrangler both
   * re-read `.env` on module reload). Silent no-op when no containers
   * are up.
   */
  async syncEnvsToAllContainers(sessionId: string): Promise<void> {
    const envs = resolveSessionEnvs(sessionId);
    const body = renderDotEnv(envs);
    const targets: Array<{ containerId: string; workdir: string }> = [];
    const primary = this.sandboxes.get(sessionId);
    if (primary?.containerId) {
      targets.push({ containerId: primary.containerId, workdir: primary.workdir });
    }
    for (const svc of this.listServices(sessionId)) {
      if (svc.containerId) targets.push({ containerId: svc.containerId, workdir: svc.workdir });
    }
    if (targets.length === 0 || !this.driver) return;
    const driver = this.driver;
    await Promise.allSettled(
      targets.map((t) =>
        driver.writeFile(t.containerId, `${t.workdir}/.env`, body, { recursive: true }),
      ),
    );
  }

  /** Tear down a secondary service. Primary sandbox is untouched. */
  async destroyService(
    sessionId: string,
    serviceId: string,
    reason = 'explicit',
  ): Promise<void> {
    const key = this.serviceKey(sessionId, serviceId);
    const sb = this.services.get(key);
    if (!sb) return;
    sb.status = 'destroying';
    this.emit({ kind: 'destroying', sandboxId: sb.id, reason });
    try {
      if (sb.containerId && this.driver) {
        await this.driver.destroy(sb.containerId);
      }
    } catch (e) {
      console.warn(
        `[sandbox-manager] destroy service ${sessionId}:${serviceId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.allocator.release(sb.hostPort);
      this.services.delete(key);
      sb.status = 'destroyed';
      const store = getServicesStore();
      const numericId = Number(sessionId);
      if (store && Number.isFinite(numericId)) {
        try {
          if (shouldHardDeleteService(reason)) {
            // Explicit user remove (DELETE /services/:id). Wipes the
            // persisted row so the UI list stops reporting it.
            store.delete(numericId, serviceId);
          } else {
            // Transient destroys (retry, session-end, abort, reaper,
            // TTL). Preserve the row as `status='destroyed'` — the
            // project link in `company_session_projects` would
            // otherwise become orphaned, leaving files on disk the
            // UI can never re-attach to a container. Keeping a
            // tombstone lets GET /services surface the orphan +
            // POST /services/:id/retry re-provision with the same
            // stack/limits it had before.
            store.patch(numericId, serviceId, {
              status: 'destroyed',
              error: `destroyed (${reason})`,
              container_id: sb.containerId,
            });
          }
        } catch { /* logged */ }
      }
      this.emit({ kind: 'destroyed', sandboxId: sb.id });

      // Prune the managed PREVIEW_URL_* env for the removed service
      // and push fresh .env into the survivors.
      this.syncManagedEnvs(sessionId);
      void this.syncEnvsToAllContainers(sessionId).catch(() => void 0);

      // When the session has no more additional services AND the
      // primary is gone too, drop the shared network. When the primary
      // is still up we leave the network alive so future additions are
      // cheap.
      if (this.listServices(sessionId).length === 0 && !this.sandboxes.has(sessionId)) {
        await destroySessionNetwork(sessionId);
      }
    }
  }

  /**
   * Persist a service row mirroring `persist()` for primary sandboxes.
   * Silent when either the stores or the session id aren't numeric
   * (test paths use string ids).
   */
  private persistService(
    sessionId: string,
    serviceId: string,
    name: string,
    sb: Sandbox,
    statusOverride?: PersistedSandboxStatus,
  ): void {
    const store = getServicesStore();
    if (!store) return;
    const numericId = Number(sessionId);
    if (!Number.isFinite(numericId)) return;
    try {
      // Defensive: free up any stale row sitting on this container_id
      // (non-destroyed state) from a prior provisioning attempt that
      // crashed before its success UPDATE landed. The partial unique
      // index `idx_company_sandbox_services_container` (migration 035)
      // would otherwise reject the upsert below with a
      // `UNIQUE constraint failed: company_sandbox_services.container_id`.
      const released = store.releaseStaleContainerId(sb.containerId, numericId, serviceId);
      if (released > 0) {
        console.warn(
          `[sandbox-manager] persistService ${sessionId}:${serviceId} freed ${released} stale row(s) on container_id=${sb.containerId.slice(0, 12)}`,
        );
      }
      // Same defensive release for `host_port` — the partial unique
      // index `idx_company_sandbox_services_port` rejects the upsert
      // when an old non-destroyed row still claims the same port.
      // This is the typical aftermath of a provider crash where the
      // old container was reaped but the row never got demoted.
      const releasedPort = store.releaseStaleHostPort(sb.hostPort, numericId, serviceId);
      if (releasedPort > 0) {
        console.warn(
          `[sandbox-manager] persistService ${sessionId}:${serviceId} freed ${releasedPort} stale row(s) on host_port=${sb.hostPort}`,
        );
      }
      store.upsert({
        session_id: numericId,
        service_id: serviceId,
        name,
        container_id: sb.containerId,
        runtime: sb.runtime,
        stack: sb.stack,
        workdir: sb.workdir,
        host_workdir_mount: sb.hostWorkdirMount ?? null,
        host_port: sb.hostPort,
        limits: sb.limits as unknown as Record<string, unknown>,
        status: statusOverride ?? this.toPersistedStatus(sb.status),
        error: sb.error ?? null,
        is_primary: false,
        last_access_at_ms: sb.lastAccessAt,
        paused_at_ms: sb.status === 'paused' ? Date.now() : null,
      });
    } catch (e) {
      console.warn(
        `[sandbox-manager] persistService ${sessionId}:${serviceId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────── provision

  /**
   * Create (or return the existing) sandbox for `sessionId`. Idempotent
   * on the happy path — calling twice with the same id while the first
   * call is still provisioning awaits that first call instead of
   * racing a second container into existence.
   */
  async provision(req: ProvisionRequest): Promise<Sandbox> {
    // Drive reclaim/reconcile BEFORE the early-return — reconcile may
    // have just restored an in-memory entry for this session.
    const driver = await this.resolveDriverOnce();

    const existing = this.sandboxes.get(req.sessionId);
    if (existing) {
      // `retry:true` from the UI's "Retry primary" button means
      // "tear this down and rebuild, whatever state you're in" — the
      // user already clicked because the current container is broken
      // in a way we can't detect (bad build, wedged dev-server,
      // corrupted node_modules). So we honor retry on 'error' AND on
      // healthy-looking 'running' too. In-flight 'provisioning' /
      // 'pending' windows are left alone — the running provision is
      // already recreating the container; double-teardown would race.
      const retryable = new Set(['error', 'running', 'destroyed']);
      if (req.retry && retryable.has(existing.status)) {
        await this.destroyInternal(req.sessionId, 'retry-after-error');
      } else if (existing.status === 'paused') {
        // Session was paused by the soft-TTL reaper (or explicitly).
        // Wake it up — filesystem is intact, just start the container
        // back up and relaunch Vite. Cheap (~5s) vs full reprovision.
        return await this.resumeSandbox(req.sessionId);
      } else if (existing.status === 'pending' || existing.status === 'provisioning' || existing.status === 'destroying') {
        // Don't touch in-flight states — another provision is already
        // mutating this row. Returning the seed lets the caller wait
        // for the in-flight provision to finish.
        existing.lastAccessAt = Date.now();
        this.persist(existing);
        return existing;
      } else {
        // 'ready' / 'error' fall here. Verify the container actually
        // exists in the runtime before trusting the in-memory entry —
        // the container can disappear out-of-band (TTL reaped by
        // podman, Docker Desktop reset, OS reboot, manual `podman rm`)
        // and the in-memory map keeps the stale binding pointing at a
        // dead `containerId`. Without this check, every subsequent
        // tool call from the agent fails with `container "" does not
        // exist` and the master gets stuck in a recovery loop
        // (session 73 incident). Heal transparently by falling through
        // to a fresh provision when we detect the runtime disagrees.
        let alive = true;
        if (existing.containerId) {
          try {
            const inspect = await driver.inspectContainer(existing.containerId);
            alive = inspect.exists && inspect.running;
          } catch {
            alive = false;
          }
        } else {
          alive = false;
        }
        if (alive) {
          existing.lastAccessAt = Date.now();
          this.persist(existing);
          return existing;
        }
        console.warn(
          `[sandbox-manager] in-memory sandbox ${req.sessionId} points at a dead container ${(existing.containerId || '<empty>').slice(0, 12)} — auto-reprovisioning (host bind-mount preserves files)`,
        );
        await this.destroyInternal(req.sessionId, 'container-disappeared').catch(() => void 0);
      }
    }
    if (this.sandboxes.size >= this.maxSandboxes) {
      throw new Error(
        `Too many concurrent sandboxes (${this.sandboxes.size}/${this.maxSandboxes}). ` +
          `Close an existing builder session or raise MCP_MAX_SANDBOXES.`,
      );
    }

    const hostPort = await this.allocator.acquire();
    const previewUrl = this.buildPreviewUrl(req.sessionId, hostPort);

    // Seed a pending record synchronously so concurrent `provision` calls
    // short-circuit via the `existing` branch above instead of racing.
    // We resolve the limits up-front so the record reflects what the
    // container WILL be created with, even during the provisioning window.
    const seedLimits = { ...DEFAULT_SANDBOX_LIMITS, ...(req.limits ?? {}) };
    const seed: Sandbox = {
      id: req.sessionId,
      containerId: '',
      runtime: driver.runtime,
      stack: req.stack,
      hostPort,
      workdir: this.workdir,
      previewUrl,
      limits: seedLimits,
      status: 'pending',
      step: 'queued',
      recentLogs: [],
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
    };
    this.sandboxes.set(req.sessionId, seed);
    // Persist the provisioning intent EARLY so even a crash during
    // container create leaves a DB breadcrumb the next boot can clean
    // up (reconcile sees row + no container → marks destroyed).
    this.persist(seed, 'provisioning');
    this.emit({ kind: 'provisioning', sandboxId: req.sessionId, stack: req.stack });
    this.recordStep(seed, 'creating-container', 'Starting container…');

    try {
      seed.status = 'provisioning';
      // Resolve the final isolation spec: start from defaults, then
      // layer in whatever the egress firewall (if enabled) dictates.
      // `NetworkController.ensure()` is idempotent and cheap after the
      // first call per process.
      const egress = await getNetworkController().ensure();
      const isolation = egress
        ? {
            ...DEFAULT_SANDBOX_ISOLATION,
            network: DEFAULT_SANDBOX_ISOLATION.network ?? egress.networkName,
            httpProxy: DEFAULT_SANDBOX_ISOLATION.httpProxy ?? egress.proxyUrl,
          }
        : DEFAULT_SANDBOX_ISOLATION;

      // Resolve limits: per-session override → env defaults → hard
      // defaults. We merge rather than replace so a caller that only
      // wants to bump memory doesn't have to restate cpus/pids.
      const limits = {
        ...DEFAULT_SANDBOX_LIMITS,
        ...(req.limits ?? {}),
      };

      // Resolve the persistent host bind-mount for this session. Priority:
      //   1. Explicit `req.hostWorkdirMount` — caller supplies the linked
      //      virtual-project's `root_path` (e.g. `data/virtual-projects/<uuid>`)
      //      so the sandbox writes INTO the same directory the project
      //      row points at (indexable, listable in the Projects UI).
      //   2. Default sessionId-based path (`data/virtual-projects/<sessionId>`) —
      //      used by tests and direct manager calls that don't know about
      //      the project layer.
      //   3. `null` when disabled (`MCP_SANDBOX_BIND_MOUNT=0`) — legacy
      //      ephemeral-fs + tar-archive lifecycle.
      const hostWorkdirMount = req.hostWorkdirMount ?? resolveHostWorkdirMount(req.sessionId);
      const nodeModulesVolumeName = hostWorkdirMount
        ? nodeModulesVolumeFor(req.sessionId)
        : undefined;
      if (hostWorkdirMount) {
        // Ensure the host dir exists BEFORE the container is created —
        // docker/podman creates missing bind-mount sources as root-owned
        // directories, which we then can't chown away from inside.
        try {
          mkdirSync(hostWorkdirMount, { recursive: true });
        } catch (e) {
          throw new Error(
            `Failed to prepare host workdir ${hostWorkdirMount}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        // Import any checked-in `.env` sitting in the project dir so
        // values like API_BASE_URL or DATABASE_URL that the operator
        // already wrote to disk become part of the session envs
        // BEFORE we materialize /app/.env. Only fills missing keys —
        // user edits via the Env tab always take precedence.
        importDotEnvIntoStore(hostWorkdirMount, req.sessionId);
      }

      const sharedEnvs = resolveSessionEnvs(req.sessionId);
      const { containerId } = await driver.create({
        sandboxId: req.sessionId,
        image: this.nodeImage,
        stack: req.stack,
        workdir: this.workdir,
        hostPort,
        containerPort: this.devServerPort,
        limits,
        isolation,
        env: Object.keys(sharedEnvs).length > 0 ? sharedEnvs : undefined,
        hostWorkdirMount: hostWorkdirMount ?? undefined,
        nodeModulesVolumeName,
      });
      seed.containerId = containerId;
      seed.hostWorkdirMount = hostWorkdirMount ?? undefined;
      seed.nodeModulesVolumeName = nodeModulesVolumeName;

      // Ensure the workdir exists and is writable by the non-root user
      // the container will run code as. Executed as root via the
      // driver's `user: '0:0'` exec override — the Dockerfile already
      // does this at build time, but we repeat it here so third-party
      // images (and older builds of our own image) still work. This
      // also papers over the Podman "workdir does not exist" failure.
      await this.prepareWorkdir(driver, containerId, this.workdir, isolation.user);

      // Materialize /app/.env as soon as the workdir is writable so
      // scaffolders (vite-api, cf-worker) that reference env vars
      // during `npm install` / `wrangler dev` startup see them.
      if (Object.keys(sharedEnvs).length > 0) {
        try {
          await driver.writeFile(
            containerId,
            `${this.workdir}/.env`,
            renderDotEnv(sharedEnvs),
            { recursive: true },
          );
        } catch (e) {
          this.appendLog(
            seed,
            'info',
            `(non-fatal) write .env failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // Persistence decision tree:
      //   1. Bind-mount active AND host dir already has package.json
      //      → workdir is already populated. Skip scaffolding + skip
      //        archive restore. Just relaunch the dev server.
      //   2. Bind-mount active AND host dir empty, but a legacy tar
      //      exists → one-shot migration: import the tar into the
      //        container (which lands on the mounted host dir), then
      //        delete the tar. Subsequent provisions take path 1.
      //   3. No bind-mount AND archive exists → legacy path: restore
      //      the tar into the ephemeral container fs.
      //   4. Otherwise → scaffold fresh.
      const hostWorkdirPopulated =
        !!hostWorkdirMount && hasInitializedWorkdir(hostWorkdirMount);

      let archiveToRestore = req.restoreArchive;
      if (!archiveToRestore && !hostWorkdirPopulated) {
        try {
          const auto = await loadArchive(req.sessionId);
          if (auto) {
            archiveToRestore = auto;
            this.appendLog(seed, 'info', 'Restoring workdir from previous session archive…');
          }
        } catch (e) {
          this.appendLog(
            seed,
            'info',
            `(non-fatal) could not read archive: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      if (hostWorkdirPopulated) {
        // The bind-mounted host dir already holds the user's code. Trust
        // it verbatim: no scaffolder, no tar restore. Just start Vite.
        this.recordStep(seed, 'starting-dev-server', 'Resuming persisted workdir…');
        await this.relaunchDevServer(driver, containerId, this.workdir, req.signal, req.stack);
      } else if (archiveToRestore) {
        // Fast path: the caller had a previously-archived workdir.
        // Skip scaffolding entirely — the archive already contains
        // `package.json`, `node_modules` and the dev-server config.
        this.recordStep(seed, 'installing-deps', 'Restoring workdir from archive…');
        await driver.importWorkdir(containerId, this.workdir, archiveToRestore);
        // If we just migrated a legacy tar into a bind-mounted workdir,
        // drop the tar — the host dir is now the source of truth.
        if (hostWorkdirMount) {
          try {
            rmSync(archivePath(req.sessionId), { force: true });
          } catch {
            /* best effort */
          }
        }
        this.recordStep(seed, 'starting-dev-server', 'Starting dev server…');
        await this.relaunchDevServer(driver, containerId, this.workdir, req.signal, req.stack);
      } else {
        const scaffolder = getScaffolder(req.stack, { includeE2e: req.includeE2e });
        await scaffolder.scaffold({
          sandboxId: req.sessionId,
          containerId,
          workdir: this.workdir,
          devServerPort: this.devServerPort,
          previewUrl,
          previewPathPrefix: previewPathPrefixOf(previewUrl),
          driver,
          signal: req.signal,
          includeE2e: req.includeE2e,
          emit: (e) => {
            // Split scaffolder events: `step` updates drive the UI
            // label + record, `log` entries append to the ring buffer,
            // everything else just goes to observers untouched.
            if (e.kind === 'step') {
              this.recordStep(seed, e.step, e.message);
            } else if (e.kind === 'log') {
              this.appendLog(seed, 'info', e.chunk);
            }
            this.emit(e);
          },
        });
      }

      seed.status = 'ready';
      seed.step = 'ready';
      seed.lastAccessAt = Date.now();
      this.appendLog(seed, 'info', 'Dev server is ready.');
      this.persist(seed, 'running');
      // First sync of managed envs happens on primary ready — before
      // this point PREVIEW_URL_MAIN has no live target. Secondary adds
      // re-trigger the sync from their own happy path.
      this.syncManagedEnvs(req.sessionId);
      this.emit({ kind: 'ready', sandboxId: req.sessionId, previewUrl });
      return seed;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // IMPORTANT: we keep the sandbox record around in `error` state.
      // The previous implementation called `destroyInternal` here,
      // which wiped the record — making the UI think nothing happened
      // AND freeing the host port so the NEXT provision reused it,
      // which is how two sessions ended up colliding on the same port.
      // Now we tear the container down (so it isn't stuck in a bad
      // state inside docker) but keep the in-memory record with its
      // `error` message visible until the caller explicitly retries
      // (POST /sandbox with retry=true) or deletes the session.
      seed.status = 'error';
      seed.step = 'error';
      seed.error = message;
      this.appendLog(seed, 'error', message);
      this.persist(seed, 'error');
      this.emit({ kind: 'error', sandboxId: req.sessionId, message });

      // Best-effort: destroy the half-built container but DO NOT drop
      // our in-memory record. Port stays claimed until the user
      // retries or deletes the session — intentional, so the error
      // context remains available for inspection.
      if (seed.containerId) {
        try {
          await driver.destroy(seed.containerId);
          seed.containerId = '';
        } catch (cleanupErr) {
          // Log but don't mask the original failure.
          this.appendLog(
            seed,
            'error',
            `(also) cleanup destroy failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          );
        }
      }
      throw e;
    }
  }

  /**
   * Kill any running `vite`/`node` process inside the container and
   * relaunch the dev server fresh. Used by the "Restart dev-server"
   * UI action when the agent corrupted `vite.config.ts` or the dev
   * server crashed but the container is still alive — restarting the
   * whole sandbox would destroy the agent's work; this preserves it.
   *
   * Also re-writes `vite.config.ts` with our canonical proxy-aware
   * template in case the agent overwrote it. Non-proxy related user
   * content in the workdir is untouched.
   */
  async restartDevServer(sessionId: string): Promise<void> {
    const sb = this.sandboxes.get(sessionId);
    if (!sb || !sb.containerId || !this.driver) {
      throw new Error(`No running sandbox for session ${sessionId}`);
    }
    this.appendLog(sb, 'info', 'Restart requested — killing dev-server and relaunching…');
    await this.recoverDevServer(sb);
    sb.step = 'ready';
    sb.lastAccessAt = Date.now();
    this.appendLog(sb, 'info', 'Dev server restarted.');
    this.emit({ kind: 'ready', sandboxId: sb.id, previewUrl: sb.previewUrl });
  }

  /**
   * Workdir-preserving dev-server recovery: kill `vite|node`, re-render
   * the proxy-aware `vite.config.ts`, and relaunch Vite. Only
   * `vite.config.ts` is rewritten — every other file in the workdir is
   * left untouched. Shared between `restartDevServer` (manual) and
   * `resumeSandbox` (fallback when the initial relaunch fails).
   */
  private async recoverDevServer(sb: Sandbox): Promise<void> {
    if (!sb.containerId || !this.driver) {
      throw new Error(`No running sandbox for session ${sb.id}`);
    }
    const driver = this.driver;

    // Kill every `node`/`vite` PID. `pkill` exits non-zero when nothing
    // matches; we tolerate that case.
    await driver.exec(sb.containerId, `pkill -f 'vite|node' 2>/dev/null || true`, {
      cwd: undefined,
      timeoutMs: 5_000,
    });

    // Re-write the proxy-aware vite.config.ts. If the agent replaced it
    // with a default one, the dev server would bind only to 127.0.0.1
    // inside the container and the host port-forward would fail with
    // ECONNREFUSED. We use the same renderer the scaffolder uses.
    const { renderViteConfig } = await import('./scaffolders/vite-scaffolder-base.js');
    const previewPathPrefix = previewPathPrefixOf(sb.previewUrl);
    const cfg = renderViteConfig({
      base: previewPathPrefix,
      hmrPath: `${previewPathPrefix.replace(/\/$/, '')}/@vite/hmr`,
      devPort: this.devServerPort,
    });
    await driver.writeFile(sb.containerId, `${sb.workdir}/vite.config.ts`, cfg, {
      recursive: true,
    });

    sb.step = 'starting-dev-server';
    this.emit({
      kind: 'step',
      sandboxId: sb.id,
      step: 'starting-dev-server',
      message: 'Relaunching dev server…',
    });
    await this.relaunchDevServer(driver, sb.containerId, sb.workdir, undefined, sb.stack);
  }

  /**
   * Export the sandbox's workdir as a tar archive. Caller persists the
   * bytes and passes them back as `restoreArchive` on the next
   * `provision()` to skip scaffolding.
   *
   * Returns `null` when there's no live sandbox for `sessionId` or when
   * the driver reports the container went away before export could run.
   */
  async archive(sessionId: string): Promise<Buffer | null> {
    const sb = this.sandboxes.get(sessionId);
    if (!sb || !sb.containerId || !this.driver) return null;
    if (sb.status !== 'ready' && sb.status !== 'error') return null;
    try {
      return await this.driver.exportWorkdir(sb.containerId, sb.workdir);
    } catch (e) {
      console.warn(
        `[sandbox-manager] archive ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** Mark a sandbox as recently touched. Called on every tool invocation. */
  touch(sessionId: string): void {
    const sb = this.sandboxes.get(sessionId);
    if (sb) {
      sb.lastAccessAt = Date.now();
      // Persist on every touch is too chatty for a busy session;
      // persist only on status-changing moments. The periodic reaper
      // will write the last_access_at during its sweep.
    }
  }

  /**
   * Soft eviction: `podman stop` the container but keep it around.
   * Filesystem layer is preserved so `resumeSandbox` is instant.
   * Idempotent — calling on an already-paused sandbox is a no-op.
   */
  async pauseSandbox(sessionId: string, reason = 'idle-ttl'): Promise<void> {
    const sb = this.sandboxes.get(sessionId);
    if (!sb) return;
    if (sb.status === 'paused') return;
    if (sb.status !== 'ready') {
      // Can't pause provisioning/error sandboxes. Let them resolve first.
      return;
    }
    const driver = this.driver;
    if (!driver || !sb.containerId) return;

    this.appendLog(sb, 'info', `Pausing (reason: ${reason})…`);

    // Snapshot the workdir BEFORE stopping the container — but only
    // when bind-mount persistence is disabled. With a bind-mount the
    // workdir already lives on the host; exporting a tar would be
    // duplicated data that goes stale the moment the user resumes.
    if (!sb.hostWorkdirMount) {
      try {
        const tar = await driver.exportWorkdir(sb.containerId, sb.workdir);
        if (tar && tar.byteLength > 0) {
          await saveArchive(sb.id, tar);
          this.appendLog(sb, 'info', `Archived workdir (${tar.byteLength} bytes) before pause.`);
        }
      } catch (e) {
        console.warn(
          `[sandbox-manager] pre-pause archive ${sb.id} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    try {
      await driver.stopContainer(sb.containerId, 5);
    } catch (e) {
      this.appendLog(
        sb,
        'error',
        `Pause failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    sb.status = 'paused';
    sb.step = 'queued';
    this.allocator.release(sb.hostPort); // port is no longer bound
    this.persist(sb, 'paused');
    this.emit({ kind: 'paused', sandboxId: sb.id, reason });
    console.log(
      `[sandbox-manager] paused session=${sb.id} container=${sb.containerId.slice(0, 12)} reason=${reason}`,
    );
  }

  /**
   * Wake a paused sandbox: `podman start` + relaunch Vite. Cheap
   * (~5s) compared to re-provisioning from archive (~90s). Preserves
   * every file + node_modules + cached deps the agent produced.
   */
  async resumeSandbox(sessionId: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(sessionId);
    if (!sb) throw new Error(`No sandbox for session ${sessionId}`);
    if (sb.status === 'ready') return sb;
    if (sb.status !== 'paused') {
      throw new Error(`Cannot resume session ${sessionId} from status '${sb.status}'`);
    }
    const driver = this.driver;
    if (!driver || !sb.containerId) throw new Error('No driver or container id');

    this.appendLog(sb, 'info', 'Resuming from paused state…');
    this.recordStep(sb, 'starting-dev-server', 'Starting container…');

    await driver.startContainer(sb.containerId);
    // Re-reserve the port: `podman start` re-binds the mapping we set
    // at create time (`-p 127.0.0.1:<hostPort>:5173`), so the same
    // port comes back. Mirror that in the allocator.
    await this.reservePort(sb.hostPort);

    // Dev server died when the container was stopped. Relaunch it —
    // vite.config.ts + node_modules are already in place.
    this.recordStep(sb, 'starting-dev-server', 'Relaunching dev server…');
    try {
      await this.relaunchDevServer(driver, sb.containerId, sb.workdir, undefined, sb.stack);
    } catch (e) {
      // Fallback: if Vite didn't come up cleanly (e.g. the agent
      // corrupted vite.config.ts before the pause, or a stale process
      // pinned the port), run the workdir-preserving recovery path.
      // Only `vite.config.ts` is rewritten — every other file in the
      // sandbox's workdir survives.
      this.appendLog(
        sb,
        'info',
        `Resume relaunch failed (${e instanceof Error ? e.message : String(e)}). Falling back to full dev-server recovery…`,
      );
      await this.recoverDevServer(sb);
    }

    sb.status = 'ready';
    sb.step = 'ready';
    sb.lastAccessAt = Date.now();
    this.appendLog(sb, 'info', 'Resumed successfully.');
    this.persist(sb, 'running');
    this.emit({ kind: 'resumed', sandboxId: sb.id, previewUrl: sb.previewUrl });
    this.syncManagedEnvs(sessionId);
    return sb;
  }

  async destroy(sessionId: string, reason = 'explicit'): Promise<void> {
    await this.destroyInternal(sessionId, reason);
  }

  async destroyAll(reason = 'shutdown'): Promise<void> {
    this.shuttingDown = true;
    this.stopReaper();
    const ids = [...this.sandboxes.keys()];
    // Services first: their destroy path attempts to remove the shared
    // network, and we want that to complete BEFORE we tear the primary
    // containers that also sit on it.
    const serviceKeys = [...this.services.keys()];
    await Promise.allSettled(
      serviceKeys.map((key) => {
        const [sid, svcId] = key.split(':');
        return this.destroyService(sid!, svcId!, reason);
      }),
    );
    await Promise.allSettled(ids.map((id) => this.destroyInternal(id, reason)));
  }

  // ────────────────────────────────────────────────────────────── internals

  /**
   * Update the sandbox's `step` + log the transition. This is the one
   * writer for `step`; everything else reads it. The emit is a separate
   * event so UIs that prefer SSE can react without re-polling.
   */
  private recordStep(sb: Sandbox, step: SandboxStep, message: string): void {
    sb.step = step;
    this.appendLog(sb, 'info', message);
    this.emit({ kind: 'step', sandboxId: sb.id, step, message });
  }

  private appendLog(sb: Sandbox, level: SandboxLogLine['level'], text: string): void {
    // Normalize: strip trailing newlines from scaffolder chunks, cap
    // each individual message so a runaway `npm install` stderr line
    // can't bloat the ring buffer.
    const clean = text.replace(/\s+$/g, '').slice(0, 2_000);
    if (!clean) return;
    sb.recentLogs.push({ at: Date.now(), level, text: clean });
    if (sb.recentLogs.length > MAX_LOG_LINES) {
      sb.recentLogs.splice(0, sb.recentLogs.length - MAX_LOG_LINES);
    }
  }

  private async resolveDriverOnce(): Promise<ISandboxDriver> {
    if (!this.driver) {
      this.driver = await resolveDriver();
      // Ensure the sandbox base image is available locally. For CLI drivers
      // (Docker/Podman) this is a no-op when the image already exists; on a
      // fresh host it builds it automatically instead of failing at run-time
      // with a confusing "registry not found" error.
      if (this.driver instanceof CliOciDriver) {
        const buildCtx = join(dirname(fileURLToPath(import.meta.url)), '../../../docker/sandbox-node');
        await this.driver.ensureImage(this.nodeImage, buildCtx).catch((e) =>
          console.warn(
            `[sandbox-manager] image ensure failed (will retry on first sandbox): ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      // First driver resolution is where we do BOTH kinds of recovery:
      //   1. Reconcile DB rows with the runtime — living containers are
      //      reclaimed into the in-memory map; gone ones are marked
      //      destroyed; paused ones stay paused but port-reserved.
      //   2. Scan for legacy orphans (containers that carry our labels
      //      but have no DB row — a crashed process that never wrote
      //      to DB before dying). These get archived + removed.
      // Both are best-effort and don't throw — a recovery failure must
      // not prevent fresh sessions from starting.
      await this.reconcileFromDb(this.driver).catch((e) =>
        console.warn(
          `[sandbox-manager] DB reconcile failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
      // Build the "keep-alive" set from what reconcile just populated:
      // ANY container reclaimed into our in-memory map is NOT an orphan,
      // regardless of whether it's ready or paused. Without this guard
      // `reapOrphans` used to nuke paused sessions on every server boot.
      // Include secondary service containers too — they are reconciled by
      // `reconcileServicesFromDb` (called inside `reconcileFromDb`) into
      // `this.services`, but the original code only iterated `this.sandboxes`
      // (primary). Omitting them caused microservice containers to appear as
      // orphans and be destroyed on every boot.
      const reclaimedIds = new Set<string>();
      for (const sb of this.sandboxes.values()) {
        if (sb.containerId) reclaimedIds.add(sb.containerId);
      }
      for (const svc of this.services.values()) {
        if (svc.containerId) reclaimedIds.add(svc.containerId);
      }
      await this.reapOrphans(this.driver, reclaimedIds).catch((e) =>
        console.warn(
          `[sandbox-manager] orphan reaper failed: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
    return this.driver;
  }

  /**
   * Walk every `company_sandboxes` row marked non-destroyed and align
   * the in-memory map with the runtime's actual state:
   *
   *   row status    runtime          → action
   *   ───────────── ──────────────── ─────────────────────────────────
   *   running       running          reclaim (add to map, status=ready)
   *   running       stopped          mark paused in DB; add to map
   *   paused        stopped          reclaim (add to map, status=paused)
   *   paused        running          rare — treat as running, update DB
   *   any           gone             mark destroyed in DB; skip
   *
   * Fresh containers (no DB row) take the normal `provision()` path.
   * Legacy orphans (container has label but no DB row) are handled by
   * `reapOrphans()`.
   */
  private async reconcileFromDb(driver: ISandboxDriver): Promise<void> {
    const store = getStore();
    if (!store) return;
    const rows = store.listActive();
    if (rows.length === 0) return;

    let reclaimed = 0;
    let lost = 0;
    for (const row of rows) {
      try {
        const inspect = await driver.inspectContainer(row.container_id);
        if (!inspect.exists) {
          // Container is gone (pruned, VM reset). Clear the DB row so
          // the next provision falls through to archive-restore.
          store.delete(row.session_id);
          this.allocator.release(row.host_port);
          lost++;
          continue;
        }

        // Container exists. Reserve its port in the in-memory allocator
        // (the allocator starts fresh on each process) so a fresh
        // provision in a DIFFERENT session doesn't grab the same port.
        await this.reservePort(row.host_port);

        const effectiveStatus: SandboxStatus = inspect.running
          ? 'ready'
          : row.status === 'paused'
            ? 'paused'
            : 'paused'; // running-in-DB but stopped-in-runtime → now paused

        const limits = this.parseLimits(row.limits_json);
        const previewUrl = this.buildPreviewUrl(String(row.session_id), row.host_port);
        const sb: Sandbox = {
          id: String(row.session_id),
          containerId: row.container_id,
          runtime: row.runtime,
          stack: row.stack as SandboxStack,
          hostPort: row.host_port,
          workdir: row.workdir,
          previewUrl,
          limits,
          status: effectiveStatus,
          step: effectiveStatus === 'ready' ? 'ready' : 'queued',
          recentLogs: [
            { at: Date.now(), level: 'info', text: `Reclaimed from DB (status=${effectiveStatus})` },
          ],
          createdAt: new Date(row.created_at).getTime() || Date.now(),
          lastAccessAt: row.last_access_at_ms,
          error: row.error ?? undefined,
        };
        this.sandboxes.set(sb.id, sb);

        // If DB and runtime disagree, rewrite DB to the truthful state.
        if (effectiveStatus === 'paused' && row.status !== 'paused') {
          store.patch(row.session_id, { status: 'paused', paused_at_ms: Date.now() });
        } else if (effectiveStatus === 'ready' && row.status === 'paused') {
          store.patch(row.session_id, { status: 'running', paused_at_ms: null });
        }
        reclaimed++;
      } catch (e) {
        console.warn(
          `[sandbox-manager] reconcile session=${row.session_id} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (reclaimed > 0 || lost > 0) {
      console.log(
        `[sandbox-manager] reconciled from DB: ${reclaimed} reclaimed, ${lost} lost (container gone)`,
      );
    }

    // Secondary services (migration 035) live in a separate table and
    // had NO reconcile path, which meant every server reboot + page
    // reload left the `services` map empty while rows persisted in DB
    // — preview of microservices returned 404 because `getService`
    // couldn't find anything. Run the same living/paused/gone logic
    // for each service row and rebuild `this.services`.
    await this.reconcileServicesFromDb(driver);
  }

  private async reconcileServicesFromDb(driver: ISandboxDriver): Promise<void> {
    const svcStore = getServicesStore();
    if (!svcStore) return;
    const rows = svcStore.listActive();
    if (rows.length === 0) return;

    let reclaimed = 0;
    let reprovisioned = 0;
    let orphan = 0;
    for (const row of rows) {
      try {
        const inspect = await driver.inspectContainer(row.container_id);
        if (!inspect.exists) {
          // Container is gone (image rebuilt, docker prune, host reset)
          // — but the service row is a durable "this session has this
          // microservice" record the user set up intentionally, AND the
          // workdir persists on the host at `row.workdir_mount`. Instead
          // of deleting the row (which erased microservices from the UI
          // on every image rebuild) we re-provision the container with
          // the same spec. The scaffolder detects the populated workdir
          // and skips fresh scaffolding, just relaunching the dev server.
          //
          // Pre-requisite: the primary sandbox must already be in the
          // services map (reconcileFromDb ran first). If it isn't (the
          // primary was also lost and not yet reclaimed), we leave the
          // stale row in place and bump paused_at so the UI surfaces
          // the state for the user to retry manually.
          this.allocator.release(row.host_port);
          const primarySessionId = String(row.session_id);
          const primary = this.sandboxes.get(primarySessionId);
          if (!primary) {
            svcStore.patch(row.session_id, row.service_id, {
              status: 'error',
              error: 'primary sandbox unavailable at reconcile; retry from the UI',
              paused_at_ms: Date.now(),
            });
            orphan++;
            continue;
          }
          try {
            await this.provisionAdditionalService({
              sessionId: primarySessionId,
              serviceId: row.service_id,
              stack: row.stack as SandboxStack,
              name: row.name || row.service_id,
              limits: this.parseLimits(row.limits_json),
              // Re-bind-mount the SAME host dir the original service
              // used — this is what makes the workdir survive.
              hostWorkdirMount: row.host_workdir_mount || undefined,
            });
            reprovisioned++;
          } catch (e) {
            console.warn(
              `[sandbox-manager] service re-provision ${row.session_id}:${row.service_id} failed: ${e instanceof Error ? e.message : String(e)}`,
            );
            svcStore.patch(row.session_id, row.service_id, {
              status: 'error',
              error: e instanceof Error ? e.message : String(e),
            });
            orphan++;
          }
          continue;
        }
        await this.reservePort(row.host_port);

        // If the service container exists but isn't running (server
        // was restarted, docker host rebooted), kick it back up
        // immediately so the preview route sees `ready` on reclaim.
        // Unlike primary sandboxes we don't implement a pause/resume
        // state machine for services — they either run or they don't.
        let startError: string | null = null;
        if (!inspect.running) {
          try {
            await driver.startContainer(row.container_id);
          } catch (e) {
            const base = e instanceof Error ? e.message : String(e);
            // Grab post-mortem before moving on so the UI's error
            // field shows exit code / OOM / last logs, not just
            // "start failed".
            const diagnostic = await this.captureContainerDiagnostic(
              driver,
              row.container_id,
            );
            startError = diagnostic ? `${base}\n\n${diagnostic}` : base;
            console.warn(
              `[sandbox-manager] service reclaim: failed to start ${row.session_id}:${row.service_id}: ${startError}`,
            );
          }
        }
        const effectiveStatus: SandboxStatus = startError ? 'error' : 'ready';
        const limits = this.parseLimits(row.limits_json);
        // Service previewUrl scheme matches the one `provisionAdditionalService`
        // emits — the `_svc` sentinel route in preview.ts relies on it.
        const previewUrl = `/preview/${encodeURIComponent(String(row.session_id))}/_svc/${encodeURIComponent(row.service_id)}/`;
        const serviceSandboxId = `${row.session_id}:${row.service_id}`;
        const sb: Sandbox = {
          id: serviceSandboxId,
          containerId: row.container_id,
          runtime: row.runtime,
          stack: row.stack as SandboxStack,
          hostPort: row.host_port,
          workdir: row.workdir,
          previewUrl,
          limits,
          status: effectiveStatus,
          step: effectiveStatus === 'ready' ? 'ready' : 'queued',
          recentLogs: [
            {
              at: Date.now(),
              level: startError ? 'error' : 'info',
              text: startError
                ? `Reclaimed service from DB but start failed: ${startError}`
                : `Reclaimed service from DB (status=${effectiveStatus})`,
            },
          ],
          createdAt: new Date(row.created_at).getTime() || Date.now(),
          lastAccessAt: row.last_access_at_ms,
          error: startError ?? row.error ?? undefined,
        };
        this.services.set(this.serviceKey(String(row.session_id), row.service_id), sb);

        // Persisted state must reflect reality. If the start failed,
        // leave the row paused so the next boot (or a manual retry) can
        // re-attempt the start path rather than assuming the container
        // is live.
        if (startError) {
          svcStore.patch(row.session_id, row.service_id, {
            status: 'paused',
            paused_at_ms: Date.now(),
            error: startError,
          });
        } else if (row.status !== 'running') {
          svcStore.patch(row.session_id, row.service_id, {
            status: 'running',
            paused_at_ms: null,
          });
        }
        reclaimed++;
      } catch (e) {
        console.warn(
          `[sandbox-manager] reconcile service=${row.session_id}:${row.service_id} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (reclaimed > 0 || reprovisioned > 0 || orphan > 0) {
      console.log(
        `[sandbox-manager] reconciled services from DB: ${reclaimed} reclaimed, ${reprovisioned} re-provisioned, ${orphan} orphan (needs retry)`,
      );
    }
  }

  /** Reserve a port in the in-memory allocator without consuming a bind probe. */
  private async reservePort(port: number): Promise<void> {
    // The allocator's acquire() does its own bind check; we can't call
    // it for a port that's ALREADY in use by a running container
    // (bind would fail). Reach into the internal set directly — this
    // is the one place we accept tight coupling to the allocator's
    // impl, justified by the fact that reconcile's whole job is to
    // mirror state that lives outside the allocator's world.
    const alloc = this.allocator as unknown as { inUse: Set<number> };
    alloc.inUse?.add(port);
  }

  private parseLimits(limitsJson: string): import('./types.js').SandboxLimits {
    try {
      const parsed = JSON.parse(limitsJson) as Partial<import('./types.js').SandboxLimits>;
      return { ...DEFAULT_SANDBOX_LIMITS, ...parsed };
    } catch {
      return DEFAULT_SANDBOX_LIMITS;
    }
  }

  /**
   * Map sandbox's domain status to the subset persisted to DB.
   * Transient values ('pending', 'destroying') collapse onto their
   * semantically nearest persisted state.
   */
  private toPersistedStatus(status: SandboxStatus): PersistedSandboxStatus {
    if (status === 'pending' || status === 'provisioning') return 'provisioning';
    if (status === 'ready') return 'running';
    if (status === 'paused') return 'paused';
    if (status === 'destroying' || status === 'destroyed') return 'destroying';
    return 'error';
  }

  /**
   * Write the current state of a sandbox to the DB. Called after every
   * transition so a crash/restart can reconstruct. No-op when the
   * store isn't wired (tests, CLI paths without DB).
   */
  private persist(sb: Sandbox, statusOverride?: PersistedSandboxStatus): void {
    const store = getStore();
    if (!store) return;
    const numericId = Number(sb.id);
    if (!Number.isFinite(numericId)) return; // non-numeric ids are only used by tests
    try {
      store.upsert({
        session_id: numericId,
        container_id: sb.containerId,
        runtime: sb.runtime,
        stack: sb.stack,
        workdir: sb.workdir,
        host_port: sb.hostPort,
        limits: sb.limits as unknown as Record<string, unknown>,
        status: statusOverride ?? this.toPersistedStatus(sb.status),
        error: sb.error ?? null,
        last_access_at_ms: sb.lastAccessAt,
        paused_at_ms: sb.status === 'paused' ? Date.now() : null,
      });
    } catch (e) {
      console.warn(
        `[sandbox-manager] persist ${sb.id} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Find and remove every container created by a previous incarnation
   * of this process. Identification is by label (`mcp.sandbox=1`), not
   * by name — that way a future rename of the naming scheme still
   * catches the old ones on upgrade.
   *
   * Implementation: we shell out through the driver's underlying CLI
   * rather than through `ISandboxDriver.destroy`, because we don't have
   * container IDs at this point — we need to ask the runtime for them
   * first. We also don't add a method to `ISandboxDriver` for this
   * because the operation is CLI-specific; E2B manages its own lifecycle.
   */
  private async reapOrphans(
    driver: ISandboxDriver,
    keepAlive: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    // Peek at the driver to grab the underlying CLI handle. The base
    // `CliOciDriver` exposes everything we need through the public
    // `shell` + `binary` on construction, but to keep encapsulation
    // we route via duck typing. E2B and any non-CLI driver return
    // null here and skip silently.
    const cli = (driver as unknown as {
      binary?: string;
      shell?: { run: (p: string, a: string[], o: { cwd: string; encoding: string }) => Promise<{ stdout: string; exitCode: number | null }> };
      globalArgs?: string[];
    });
    if (!cli.binary || !cli.shell) return;

    // Ask the runtime for id + session + workdir in a single round-trip.
    // Tab-delimited so empty label values are unambiguous (a \t\t run
    // means both labels were absent, which is the case for containers
    // labeled by an older version that predates `mcp.workdir`).
    const list = await cli.shell.run(
      cli.binary,
      [
        ...(cli.globalArgs ?? []),
        'ps', '-a',
        '--filter', 'label=mcp.sandbox=1',
        '--format', '{{.ID}}\t{{.Label "mcp.sessionId"}}\t{{.Label "mcp.workdir"}}',
      ],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    if (list.exitCode !== 0) return;

    interface OrphanRow {
      id: string;
      sessionId: string;
      workdir: string;
    }
    const allLabeled: OrphanRow[] = list.stdout
      .split('\n')
      .map((line) => line.split('\t').map((s) => s.trim()))
      .filter((cols) => cols[0])
      .map((cols) => ({ id: cols[0], sessionId: cols[1] ?? '', workdir: cols[2] ?? '' }));
    if (allLabeled.length === 0) return;

    // A container is an orphan ONLY when both of these hold:
    //   1. It was not reclaimed into memory by `reconcileFromDb`
    //      (passed in via `keepAlive` — containerIds we own).
    //   2. It has no surviving row in `company_sandboxes` pointing to it.
    // Without this filter, every paused session's container was nuked on
    // server boot, destroying the workdir with only a best-effort
    // salvage as backup (and `podman cp` from a stopped container can
    // fail silently on some hosts, meaning total data loss for the
    // session's owner).
    const store = getStore();
    const dbContainerIds = new Set<string>();
    if (store) {
      for (const row of store.listActive()) {
        if (row.container_id) dbContainerIds.add(row.container_id);
      }
    }
    // Also protect secondary service containers (company_sandbox_services).
    // The original code only checked company_sandboxes (primary sandboxes),
    // so microservice containers always fell through as orphans.
    const svcStore = getServicesStore();
    if (svcStore) {
      for (const row of svcStore.listActive()) {
        if (row.container_id) dbContainerIds.add(row.container_id);
      }
    }
    const orphans = allLabeled.filter((o) => {
      if (keepAlive.has(o.id) || dbContainerIds.has(o.id)) return false;
      // Skip containers whose mcp.sessionId is not a numeric session ID.
      // All company session IDs are SQLite integer primary keys ("42") or
      // service composites ("42:api"). Chrome Service uses "chrome-service"
      // and Verdaccio uses "verdaccio-registry" — both non-numeric — so
      // they must be left alone even though they carry mcp.sandbox=1.
      const sessionPart = o.sessionId.split(':')[0] ?? '';
      if (!sessionPart || !/^\d+$/.test(sessionPart)) return false;
      return true;
    });
    const skipped = allLabeled.length - orphans.length;
    if (skipped > 0) {
      console.log(
        `[sandbox-manager] orphan reaper: skipping ${skipped} container(s) still owned by an active session`,
      );
    }
    if (orphans.length === 0) return;

    // Serial (not parallel) to keep podman-cp I/O sane on disk-backed
    // hosts. Each export is ~10-30s with node_modules; a handful of
    // orphans running in parallel would saturate I/O and lose tars
    // halfway. We accept the serial latency — it happens once per
    // server boot, on the cold path.
    let salvaged = 0;
    let destroyed = 0;
    for (const orphan of orphans) {
      // Skip salvage entirely when this session has a bind-mounted host
      // workdir — the files are already safe on disk, and `docker cp`
      // from a dying container just burns I/O.
      const orphanHostMount = orphan.sessionId
        ? resolveHostWorkdirMount(orphan.sessionId)
        : null;
      const alreadyPersisted =
        !!orphanHostMount && hasInitializedWorkdir(orphanHostMount);

      // Salvage phase: best-effort. Only attempt when we know WHERE to
      // export from (requires mcp.workdir label — present on containers
      // created by the current code; older ones just get destroyed).
      if (orphan.sessionId && orphan.workdir && !alreadyPersisted) {
        try {
          const tar = await driver.exportWorkdir(orphan.id, orphan.workdir);
          if (tar && tar.byteLength > 0) {
            await saveArchive(orphan.sessionId, tar);
            salvaged++;
            console.log(
              `[sandbox-manager] salvaged archive for session=${orphan.sessionId} ` +
                `from orphan container ${orphan.id.slice(0, 12)} (${tar.byteLength} bytes)`,
            );
          }
        } catch (e) {
          console.warn(
            `[sandbox-manager] salvage failed for session=${orphan.sessionId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // Destroy phase: always. An un-salvageable container is still
      // an orphan that must be removed before we can re-use its name.
      await cli.shell!
        .run(cli.binary!, [...(cli.globalArgs ?? []), 'rm', '-f', orphan.id], {
          cwd: process.cwd(),
          encoding: 'utf-8',
        })
        .then(() => {
          destroyed++;
        })
        .catch(() => void 0);

      // Belt-and-suspenders cleanup: a truly-orphan container might
      // still have a stale DB row or in-memory entry if it slipped
      // past `reconcileFromDb` (e.g. inspect timed out). Clear them
      // so the next `provision` for this session goes through the
      // `loadArchive` path instead of trying to resume a dead id.
      if (orphan.sessionId) {
        this.sandboxes.delete(orphan.sessionId);
        const numericId = Number(orphan.sessionId);
        if (store && Number.isFinite(numericId)) {
          try {
            store.delete(numericId);
          } catch (e) {
            console.warn(
              `[sandbox-manager] clearing stale DB row ${orphan.sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    }
    console.log(
      `[sandbox-manager] reaped ${destroyed}/${orphans.length} orphaned sandbox container(s), ` +
        `salvaged ${salvaged} archive(s)`,
    );
  }

  private async destroyInternal(sessionId: string, reason: string): Promise<void> {
    const sb = this.sandboxes.get(sessionId);
    if (!sb) return;
    sb.status = 'destroying';
    this.emit({ kind: 'destroying', sandboxId: sessionId, reason });

    // Persist the workdir BEFORE destroying. Applied to every destroy
    // path uniformly — TTL eviction, orchestrator teardown, server-side
    // abort, the 'session-deleted' reason from DELETE /sessions. The
    // DELETE path is the one exception we DON'T want to archive for;
    // its handler `deleteArchive` runs right after to wipe the file.
    //
    // Skip when the container never fully started (no containerId) or
    // when the driver isn't available. Also skip on 'session-deleted'
    // as an optimization — we'd write the tar and then immediately
    // unlink it.
    const shouldArchive =
      reason !== 'session-deleted' &&
      // Bind-mounted sandboxes already persist on the host — archiving
      // would duplicate data and stale out on the next edit.
      !sb.hostWorkdirMount &&
      sb.containerId &&
      this.driver &&
      (sb.status === 'destroying' /* was just set above */ ) &&
      (/* only worth archiving something that actually worked */
        true);
    if (shouldArchive && sb.containerId && this.driver) {
      try {
        const tar = await this.driver.exportWorkdir(sb.containerId, sb.workdir);
        if (tar && tar.byteLength > 0) {
          await saveArchive(sessionId, tar);
        }
      } catch (e) {
        // Archive is a best-effort optimization — a failure here should
        // NOT block destroy. Log so operators can diagnose repeat failures.
        console.warn(
          `[sandbox-manager] pre-destroy archive ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    try {
      if (sb.containerId && this.driver) {
        await this.driver.destroy(sb.containerId);
      }
    } catch (e) {
      // Logged, not rethrown: we still want to free local state.
      console.warn(
        `[sandbox-manager] destroy ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.allocator.release(sb.hostPort);
      this.sandboxes.delete(sessionId);
      sb.status = 'destroyed';
      // Clear the persisted row so a future provision for this session
      // doesn't try to reclaim a container that no longer exists.
      // We delete instead of mark status='destroyed' — history lives
      // in `updated_at` on company_sessions; the sandbox row is a
      // working-set cache, not an audit log.
      const store = getStore();
      if (store) {
        const numericId = Number(sessionId);
        if (Number.isFinite(numericId)) {
          try {
            store.delete(numericId);
          } catch (e) {
            console.warn(
              `[sandbox-manager] delete DB row for ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
      this.emit({ kind: 'destroyed', sandboxId: sessionId });
    }
  }

  /**
   * Ensure the sandbox workdir exists and is writable by whoever will
   * run scaffolder commands next. Designed to be forgiving:
   *
   *   1. `mkdir -p <workdir>` always succeeds for root; survives
   *      cap_drop since mkdir in a writable parent doesn't need
   *      extra capabilities.
   *   2. A best-effort `chown <user> <workdir>` aligns ownership with
   *      the isolation user. `chown` requires CAP_CHOWN, which is
   *      dropped when `--cap-drop ALL` is active — in that scenario we
   *      intentionally swallow "Operation not permitted" and rely on
   *      the image's build-time chown (the stock Dockerfile does it).
   *   3. A final write probe (`touch <workdir>/.mcp-write-probe`)
   *      confirms the isolation user can actually write. If not, we
   *      surface a clear, actionable error BEFORE the scaffolder
   *      starts producing confusing permission failures deep inside
   *      `npm create vite`.
   *
   * The test is done AS the isolation user when we have a reasonable
   * numeric spec (`uid` or `uid:gid`). Non-numeric users (e.g. `node`)
   * are resolved inside the container; if the name doesn't exist we
   * silently fall back to a root-side probe.
   */
  private async prepareWorkdir(
    driver: ISandboxDriver,
    containerId: string,
    workdir: string,
    isolationUser: string,
  ): Promise<void> {
    // Step 1: mkdir (always). Run as root for maximum portability.
    const mkdirRes = await driver.exec(containerId, `mkdir -p ${shQuote(workdir)}`, {
      cwd: undefined,
      timeoutMs: 10_000,
      user: '0:0',
    });
    if (mkdirRes.exitCode !== 0) {
      throw new Error(
        `Failed to create workdir ${workdir} (exit ${mkdirRes.exitCode}): ${mkdirRes.stderr.trim() || mkdirRes.stdout.trim()}`,
      );
    }

    // Step 2: best-effort chown. `|| true` absorbs EPERM when CAP_CHOWN
    // was dropped. This is why the stock Dockerfile bakes the chown in
    // at build time — doing it here is a convenience for third-party
    // images that didn't.
    if (isolationUser && isolationUser !== '0:0') {
      await driver.exec(
        containerId,
        `chown -R ${shQuote(isolationUser)} ${shQuote(workdir)} 2>/dev/null || true`,
        { cwd: undefined, timeoutMs: 10_000, user: '0:0' },
      );
    }

    // Step 3: write probe as the actual isolation user. Catches the
    // edge case where caps are dropped AND the image wasn't built with
    // the correct ownership — surface the issue clearly before the
    // scaffolder starts.
    const probeCmd = `touch ${shQuote(`${workdir}/.mcp-write-probe`)} && rm ${shQuote(`${workdir}/.mcp-write-probe`)}`;
    const probeRes = await driver.exec(containerId, probeCmd, {
      cwd: undefined,
      timeoutMs: 10_000,
      // Numeric uid[:gid] passes straight through; names work too if
      // the container resolves them. Empty string → container default.
      user: isolationUser || null,
    });
    if (probeRes.exitCode !== 0) {
      throw new Error(
        `Workdir ${workdir} is not writable by user '${isolationUser || 'default'}'. ` +
          `Rebuild the sandbox image so /app is chowned at build time, ` +
          `or set MCP_SANDBOX_USER='' to run as root. ` +
          `stderr: ${probeRes.stderr.trim() || probeRes.stdout.trim()}`,
      );
    }
  }

  /**
   * Restart the dev server inside a newly-created container that was
   * populated via `importWorkdir` (no scaffolder ran). Equivalent to
   * the final step of `ViteScaffolderBase.scaffold` minus install.
   */
  /**
   * Render the shell command that spawns the dev server for a given
   * stack. Different stacks take different flags — notably wrangler
   * uses `--ip` while vite uses `--host`, and passing the wrong one
   * makes wrangler exit immediately with an "unknown option" error
   * (the symptom we hit on every service reclaim before this helper
   * existed: `/tmp/dev-server.log` stayed empty because wrangler
   * died before its first stdout line).
   *
   * Everything else (vite-api, react-ts, vue-ts, angular) works
   * through `npm run dev -- --host … --port …` because their
   * package.json's `dev` script forwards to vite/ng which both
   * accept `--host`.
   */
  private buildDevServerCommand(stack: SandboxStack): string {
    const port = this.devServerPort;
    if (stack === 'cf-worker') {
      return (
        `nohup npx wrangler dev --ip 0.0.0.0 --port ${port} --local ` +
        `--show-interactive-dev-session=false > /tmp/dev-server.log 2>&1 &`
      );
    }
    return `nohup npm run dev -- --host 0.0.0.0 --port ${port} > /tmp/dev-server.log 2>&1 &`;
  }

  private async relaunchDevServer(
    driver: ISandboxDriver,
    containerId: string,
    workdir: string,
    signal?: AbortSignal,
    stack: SandboxStack = 'react-ts',
  ): Promise<void> {
    const cmd = this.buildDevServerCommand(stack);
    const spawnRes = await driver.exec(containerId, cmd, {
      cwd: workdir,
      timeoutMs: 10_000,
      signal,
    });
    if (spawnRes.exitCode !== 0) {
      throw new Error(`failed to relaunch dev server: ${spawnRes.stderr || spawnRes.stdout}`);
    }
    // Poll the in-container `ss` for the expected port, mirroring the
    // scaffolder's readiness check. 60s is enough even on cold cache
    // because deps are already installed.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('relaunch aborted');
      const probe = await driver.exec(
        containerId,
        `ss -ltn 2>/dev/null | awk '{print $4}' | grep -E ':${this.devServerPort}$' >/dev/null && echo listening || echo no`,
        { cwd: workdir, timeoutMs: 2_000 },
      );
      if (/listening/.test(probe.stdout)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('relaunched dev server failed to bind port');
  }

  private startStatsSampler(): void {
    if (this.statsIntervalMs <= 0 || this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      if (this.shuttingDown) return;
      void this.sampleAll();
    }, this.statsIntervalMs);
    this.statsTimer.unref();
  }

  private async sampleAll(): Promise<void> {
    const driver = this.driver;
    if (!driver) return;
    for (const sb of this.sandboxes.values()) {
      if (sb.status !== 'ready') continue;
      try {
        const sample = await driver.stats(sb.containerId);
        if (!sample) continue;
        this.emit({
          kind: 'stats',
          sandboxId: sb.id,
          cpuPercent: sample.cpuPercent,
          memBytes: sample.memBytes,
          sampledAt: sample.sampledAt,
        });
      } catch {
        /* best-effort — a hung stats call shouldn't kill the sampler */
      }
    }
  }

  private startReaper(): void {
    if (this.reaperTimer) return;
    // Check every 60s — TTL granularity doesn't need sub-minute accuracy.
    this.reaperTimer = setInterval(async () => {
      if (this.shuttingDown) return;
      // Make sure DB reconcile has happened before we make destroy
      // decisions — otherwise we'd skip paused sandboxes that exist
      // in DB but haven't been pulled into memory yet.
      try {
        await this.resolveDriverOnce();
      } catch {
        return; // can't reap without a driver; try next tick
      }
      const now = Date.now();

      // ─── Soft tier: running → paused ───
      // After `pauseTtlMs` of no touches, stop the container but keep
      // it around. Users coming back within `destroyAfterPauseMs` get
      // a ~5s resume instead of a fresh scaffold.
      for (const sb of this.sandboxes.values()) {
        if (sb.status !== 'ready') continue;
        const idleMs = now - sb.lastAccessAt;
        if (idleMs >= this.pauseTtlMs) {
          console.log(
            `[sandbox-manager] pausing session=${sb.id} (idle for ${Math.round(idleMs / 1000)}s ≥ ${Math.round(this.pauseTtlMs / 1000)}s soft TTL)`,
          );
          void this.pauseSandbox(sb.id, 'idle-soft-ttl');
        }
      }

      // ─── Hard tier: paused → destroyed ───
      // Check BOTH in-memory paused sandboxes and persisted ones.
      // Covers the case where the API server has been running long
      // enough that a paused sandbox crossed the hard threshold.
      const store = getStore();
      if (store) {
        const stale = store.listPausedOlderThan(this.destroyAfterPauseMs);
        for (const row of stale) {
          console.log(
            `[sandbox-manager] destroying paused session=${row.session_id} (paused for > ${Math.round(this.destroyAfterPauseMs / 1000)}s hard TTL)`,
          );
          void this.destroyInternal(String(row.session_id), 'idle-hard-ttl');
        }
      } else {
        // No DB — fall back to in-memory check.
        for (const sb of this.sandboxes.values()) {
          if (sb.status !== 'paused') continue;
          const pausedFor = now - sb.lastAccessAt;
          if (pausedFor >= this.destroyAfterPauseMs) {
            void this.destroyInternal(sb.id, 'idle-hard-ttl');
          }
        }
      }

      // Also surface errored sandboxes for cleanup after a long wait.
      // Errors stay visible in the UI so the user can click Retry;
      // after a day they're no longer actionable — clear them out.
      for (const sb of this.sandboxes.values()) {
        if (sb.status !== 'error') continue;
        const idleMs = now - sb.lastAccessAt;
        if (idleMs >= this.destroyAfterPauseMs) {
          void this.destroyInternal(sb.id, 'stale-error');
        }
      }
    }, 60_000);
    // Don't hold the event loop open — the reaper is a best-effort hygiene job.
    this.reaperTimer.unref();
  }

  private stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private installShutdownHandlers(): void {
    // Blocking shutdown: we AWAIT `destroyAll` so the process doesn't
    // exit until every sandbox has been archived + destroyed. Without
    // this, the original fire-and-forget `void destroyAll(...)` let
    // Node terminate before `driver.exportWorkdir` (a ~30s podman cp
    // for node_modules) completed — users lost everything on every
    // server restart. The orphan reaper on next boot is a safety net,
    // not a primary mechanism.
    //
    // Timeout cap: nodemon / systemd SIGKILL after ~10s if the process
    // doesn't exit. We give ourselves 8s by default (env-tunable), then
    // exit even if destroyAll isn't done — leaving orphans for the
    // next-boot reaper to salvage.
    const timeoutMs = Number(process.env.MCP_SHUTDOWN_TIMEOUT_MS ?? 8_000);
    const handler = async (signal: NodeJS.Signals) => {
      const n = this.sandboxes.size;
      if (n > 0) {
        console.log(
          `[sandbox-manager] ${signal} received, archiving ${n} sandbox(es) (${timeoutMs}ms budget)…`,
        );
      }
      try {
        await Promise.race([
          this.destroyAll(`signal:${signal}`),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`shutdown timeout after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
      } catch (e) {
        console.warn(
          `[sandbox-manager] shutdown: ${e instanceof Error ? e.message : String(e)} ` +
            `(remaining sandboxes will be salvaged by next-boot reaper)`,
        );
      }
      // Explicit exit so we don't race with other listeners that may
      // have taken ownership of the signal.
      process.exit(0);
    };
    // `once` so repeated signals don't re-enter. We don't remove existing
    // listeners — other subsystems (db, http server) have their own.
    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
  }
}

function defaultPreviewUrl(sessionId: string, _hostPort: number): string {
  // Relative to the API origin; the preview proxy rewrites `/preview/:id/*`
  // onto `http://127.0.0.1:<hostPort>/`. Subdomain strategies override
  // this via `SandboxManagerOptions.buildPreviewUrl`.
  return `/preview/${encodeURIComponent(sessionId)}/`;
}

/**
 * Minimal POSIX shell quoting — wraps in single quotes and escapes
 * embedded single quotes by closing, escaping, reopening. Used for
 * argv fragments we assemble into `sh -c "…"` strings. Inputs come
 * from code, never from LLM/user, so we don't need to defend against
 * weird bytes beyond what the shell parser expects.
 */
function shQuote(s: string): string {
  if (/^[a-zA-Z0-9_.\-/:@=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function previewPathPrefixOf(previewUrl: string): string {
  // When `previewUrl` is absolute, strip origin to get the path prefix
  // Vite's `base` config needs.
  try {
    const u = new URL(previewUrl, 'http://placeholder.invalid');
    return u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  } catch {
    return previewUrl.endsWith('/') ? previewUrl : `${previewUrl}/`;
  }
}

/**
 * Deterministic docker/podman network name shared by every service of a
 * single company session. Containers attached here address each other
 * by service_id (e.g. `fetch('http://api/ping')` from the frontend).
 */
export function sessionNetworkName(sessionId: string): string {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48);
  return `mcp-sbx-net-${safe}`;
}

/**
 * Resolve the runtime CLI binary (docker|podman) to shell out to. Mirrors
 * the logic in `cleanupSessionPersistence` — we can't go through
 * `ISandboxDriver` because network management is CLI-specific and the
 * port intentionally stays small (E2B drivers skip these helpers).
 */
function resolveRuntimeBinary(): 'docker' | 'podman' {
  return process.env.MCP_SANDBOX_RUNTIME === 'podman' ? 'podman' : 'docker';
}

/**
 * Create the per-session network if it doesn't already exist. Idempotent:
 * the `|| true` on the inspect path swallows "already exists" errors.
 * Best-effort — a failure here is logged and the caller gets `null` so
 * the container falls back to the default bridge.
 */
export async function ensureSessionNetwork(sessionId: string): Promise<string | null> {
  const name = sessionNetworkName(sessionId);
  const binary = resolveRuntimeBinary();
  return await new Promise<string | null>((resolve) => {
    // `network create` exits non-zero when the network already exists;
    // we tolerate that — any other failure is logged and returns null.
    const child = spawnChild(binary, ['network', 'inspect', name], { stdio: 'ignore' });
    child.once('error', () => resolve(null));
    child.once('close', (code) => {
      if (code === 0) {
        resolve(name);
        return;
      }
      // Network doesn't exist yet — create it.
      const create = spawnChild(binary, ['network', 'create', name], { stdio: 'ignore' });
      create.once('error', () => resolve(null));
      create.once('close', (createCode) => {
        resolve(createCode === 0 ? name : null);
      });
    });
  });
}

/**
 * Remove the per-session network. Called by destroyAllServicesForSession
 * after every attached container is gone. Best-effort.
 */
export async function destroySessionNetwork(sessionId: string): Promise<void> {
  const name = sessionNetworkName(sessionId);
  const binary = resolveRuntimeBinary();
  await new Promise<void>((resolve) => {
    const child = spawnChild(binary, ['network', 'rm', name], { stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

/**
 * Attach an already-running container to the session network. Used to
 * retro-connect the primary container (created on the default bridge)
 * to the session network when the first additional service is added.
 * Idempotent — attaching twice is a no-op error that we swallow.
 */
export async function attachContainerToSessionNetwork(
  sessionId: string,
  containerId: string,
  alias: string,
): Promise<void> {
  const name = sessionNetworkName(sessionId);
  const binary = resolveRuntimeBinary();
  await new Promise<void>((resolve) => {
    const child = spawnChild(
      binary,
      ['network', 'connect', '--alias', alias, name, containerId],
      { stdio: 'ignore' },
    );
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

// Process-wide singleton, lazily created. Keeping creation deferred lets
// tests call `setSandboxManagerForTests(new SandboxManager({ driver }))`
// before any consumer grabs the default.
let singleton: SandboxManager | null = null;

export function getSandboxManager(): SandboxManager {
  if (!singleton) singleton = new SandboxManager();
  return singleton;
}

export function setSandboxManagerForTests(manager: SandboxManager | null): void {
  singleton = manager;
}
