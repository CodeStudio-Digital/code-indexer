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
  SandboxImageSource,
  SandboxMountKind,
  SandboxStack,
  SandboxStatus,
  SandboxStep,
} from './types.js';
import { DEFAULT_SANDBOX_ISOLATION, DEFAULT_SANDBOX_LIMITS } from './types.js';

import { getScaffolder } from './scaffolders/registry.js';
import { resolveDriver, getResolvedRuntime } from './drivers/driver-factory.js';
import { CliOciDriver } from './drivers/cli-oci-driver.js';
import { getNetworkController } from './network-controller.js';
import { buildQaPreviewBaseUrl } from '../qa/url-resolver.js';
import {
  mintPreviewToken,
  parseTokenExpiry,
  QA_PREVIEW_TTL_MS,
} from '@apps/http-api/server/routes/preview-auth.js';
import { archivePath, loadArchive, saveArchive } from './archive.js';
import type {
  CompanySandboxStore,
  PersistedSandboxRow,
  PersistedSandboxStatus,
} from '@mcp/store/company-sandbox-store.js';
import type {
  CompanySandboxServicesStore,
  PersistedSandboxServiceRow,
} from '@mcp/store/company-sandbox-services-store.js';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { detectManifest } from './manifest-detector/detect.js';
import type { NodeManifest, NodePackageManager } from './manifest-detector/types.js';
import {
  type ExternalNodeDevSpec,
  type ExternalNodeFramework,
  inferExternalNodeScriptPort as inferExternalNodeScriptPortFn,
  inferExternalNodeFramework as inferExternalNodeFrameworkFn,
  inferExternalNodePort as inferExternalNodePortFn,
  externalNodeInstallCommand as externalNodeInstallCommandFn,
  externalNodeRunArgs as externalNodeRunArgsFn,
  externalNodeRunCommand as externalNodeRunCommandFn,
  externalNodeDependencyProbeCommand as externalNodeDependencyProbeCommandFn,
} from './manager/external-node.js';
import {
  buildDevServerCommand as buildDevServerCommandFn,
  devServerLogLooksReady as devServerLogLooksReadyFn,
} from './manager/dev-server.js';
import {
  ensureSafeRelPath,
  absolutize,
  hasInitializedWorkdir,
} from './manager/util/paths.js';
import {
  resolvePublicBase,
  defaultPreviewUrl,
  previewPathPrefixOf,
} from './manager/util/preview-url.js';
import {
  nodeModulesVolumeFor,
  projectImageTag,
  sessionNetworkName,
  resolveRuntimeBinary,
} from './manager/util/naming.js';
import { shQuote, truncateForLog } from './manager/util/shell.js';
import {
  parseDotEnv,
  renderDotEnv,
  resolveHostWorkdirMount,
  resolveSessionEnvs as resolveSessionEnvsFrom,
  importDotEnvIntoStore as importDotEnvIntoStoreFrom,
} from './manager/io/env-helpers.js';
import { sandboxStores } from './manager/state/stores.js';
import { SandboxRegistry } from './manager/state/registry.js';
import { SandboxEventBus } from './manager/events/event-bus.js';
import {
  SandboxPersister,
  toPersistedStatus,
  parseLimits,
} from './manager/persistence/persister.js';
import { WorkspaceIO } from './manager/io/workspace-io.js';
import { IntervalTimer } from './manager/reaper/interval-timer.js';
import { installShutdownHandlers as installShutdownHandlersImpl } from './manager/runtime/shutdown.js';
import {
  buildPrimarySandboxFromRow,
  buildServiceSandboxFromRow,
  buildAttachedServiceSandboxFromRow,
} from './manager/persistence/sandbox-from-row.js';
import {
  buildAttachedServiceSandbox,
  refreshAttachedService as refreshAttachedServiceFn,
  resolveAttachedState as resolveAttachedStateFn,
  type AttachedState,
} from './manager/attached.js';
import { collectEnvSyncTargets, pushEnvsToContainers } from './manager/env-sync.js';
import { syncManagedEnvs as syncManagedEnvsFn } from './manager/managed-envs.js';
import {
  destroyAllSandboxes,
  destroySandboxInternal,
} from './manager/destroy-sandbox.js';
import { prepareWorkdir as prepareWorkdirFn } from './manager/prepare-workdir.js';
import { reapOrphans as reapOrphansFn } from './manager/reap-orphans.js';
import { provisionAdditionalService as provisionAdditionalServiceFn } from './manager/provision-service.js';
import { provisionPrimarySandbox } from './manager/provision-primary.js';
import {
  resolveRuntimePauseTarget,
  runtimePauseContainer,
  runtimeUnpauseContainer,
  type RuntimePauseDeps,
} from './manager/runtime-pause.js';
import { executeServiceDestroy } from './manager/destroy-service.js';
import {
  type ReconcileDeps,
  reconcileAllPrimaryFromDb,
  reconcileAllServicesFromDb,
  reconcilePrimaryForSession,
  reconcileServicesForSession,
  reconcileServiceForSession,
} from './manager/reconcile.js';
import { startStatsSampler } from './manager/stats-sampler.js';
import { startReaperLoop } from './manager/reaper-loop.js';
import {
  captureContainerDiagnostic as captureContainerDiagnosticFn,
  readDevServerLog as readDevServerLogFn,
  relaunchDevServer as relaunchDevServerFn,
  waitForPublishedHttp as waitForPublishedHttpFn,
} from './manager/dev-server-runtime.js';
import {
  ensureExternalNodeDependencies as ensureExternalNodeDependenciesFn,
  resolveExternalNodeDevSpec as resolveExternalNodeDevSpecFn,
  startExternalNodeDevServer as startExternalNodeDevServerFn,
} from './manager/external-node-runtime.js';
import { archiveSandboxWorkdir } from './manager/archive-sandbox.js';
import {
  type DevLifecycleDeps,
  pauseSandbox as pauseSandboxFn,
  recoverDevServer as recoverDevServerFn,
  restartDevServer as restartDevServerFn,
  resumeSandbox as resumeSandboxFn,
  startServiceContainer as startServiceContainerFn,
} from './manager/dev-lifecycle.js';

export { sessionNetworkName };
export { cleanupSessionPersistence } from './manager/persistence/cleanup.js';

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
  sandboxStores.setSandboxStore(store);
}

export function setCompanySandboxServicesStore(
  store: CompanySandboxServicesStore | null,
): void {
  servicesStore = store;
  sandboxStores.setServicesStore(store);
}

export function setCompanySessionEnvStore(
  store: CompanySessionEnvStore | null,
): void {
  envStore = store;
  sandboxStores.setEnvStore(store);
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
  sandboxStores.setQaPreviewConfig(cfg);
}

function getStore(): CompanySandboxStore | null {
  return sandboxStore;
}

function getServicesStore(): CompanySandboxServicesStore | null {
  return servicesStore;
}

// `shouldHardDeleteService` moved to `manager/destroy-service.ts`
// alongside `executeServiceDestroy` — the only caller. Kept as a
// helper there rather than re-exported here.

/** Wrapper: passes the module-level envStore into the pure helper. */
function resolveSessionEnvs(sessionId: string): Record<string, string> {
  return resolveSessionEnvsFrom(envStore, sessionId);
}

/** Wrapper: passes the module-level envStore into the pure helper. */
function importDotEnvIntoStore(hostWorkdirMount: string, sessionId: string): void {
  importDotEnvIntoStoreFrom(envStore, hostWorkdirMount, sessionId);
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
   * Skip the SIGTERM/SIGINT shutdown handlers. Set to true in test
   * fixtures that build a one-off manager per test: production binds
   * a single process-wide singleton via `getSandboxManager()`, so
   * leaving the handlers in tests means every fresh manager piles
   * `process.once('SIGTERM', …)` listeners and Node warns about an
   * EventEmitter leak after 11+ tests in the same file.
   */
  skipShutdownHandlers?: boolean;
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


// `ExternalNodeDevSpec` moved to `manager/external-node.ts` along with
// the inference helpers it parameterises. Re-exported through the named
// import above so the rest of this file (and downstream tests) keeps
// referring to it without the path change leaking.

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
  mountKind?: SandboxMountKind;
  imageSource?: SandboxImageSource;
  dockerfilePath?: string;
  containerPortOverride?: number;
  skipDefaultCommand?: boolean;
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
 * Request to stand up a SECONDARY container for a session. Used for
 * multi-microservice sessions (frontend + worker + php). Secondary
 * services can be started independently of the primary sandbox.
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
  mountKind?: SandboxMountKind;
  imageSource?: SandboxImageSource;
  dockerfilePath?: string;
  containerPortOverride?: number;
  skipDefaultCommand?: boolean;
  /**
   * When `true`, destroy any pre-existing service with the same id
   * (including ones currently `ready`) before provisioning. Used by
   * the retry endpoint so the user can forcibly rebuild a service
   * whose container died silently, without having to delete it first.
   */
  forceRecreate?: boolean;
}

export class SandboxManager {
  private readonly registry = new SandboxRegistry();
  private readonly bus = new SandboxEventBus();
  private readonly persister = new SandboxPersister(sandboxStores);
  private readonly workspaceIO = new WorkspaceIO(this.registry, () => this.driver);
  private readonly allocator: PortAllocator;
  /** Backwards-compat accessor — primary sandboxes by sessionId. */
  private get sandboxes(): Map<string, Sandbox> {
    return this.registry.primary;
  }
  /**
   * Backwards-compat accessor — secondary containers (`service_id !== 'main'`)
   * keyed by composite `sessionId:serviceId`. Kept in a separate map so
   * primary-container paths (reconcile, reap, TTL) don't accidentally
   * touch services. Service lifecycle is driven by explicit REST calls.
   */
  private get services(): Map<string, Sandbox> {
    return this.registry.services;
  }
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
  private reaperTimer: IntervalTimer | null = null;
  private statsTimer: IntervalTimer | null = null;
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
    if (!options.skipShutdownHandlers) {
      this.installShutdownHandlers();
    }
  }

  // ──────────────────────────────────────────────────────────── observers

  subscribe(observer: SandboxObserver): () => void {
    return this.bus.subscribe(observer);
  }

  private emit(event: SandboxEvent): void {
    this.bus.emit(event);
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
    return this.workspaceIO.readText(sessionId, relPath);
  }

  /** Write a workspace-relative text file (creates parents). */
  async writeWorkspaceFile(sessionId: string, relPath: string, data: string): Promise<void> {
    return this.workspaceIO.writeText(sessionId, relPath, data);
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
    return this.workspaceIO.readBuffer(sessionId, relPath, opts);
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
    return this.workspaceIO.readBufferOnService(sessionId, serviceId, relPath, opts);
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
    return this.workspaceIO.listFilesOnService(sessionId, serviceId, relDir);
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
    return this.workspaceIO.removeDirOnService(sessionId, serviceId, relDir);
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
    return this.workspaceIO.readTextOnService(sessionId, serviceId, relPath);
  }

  // ───────────────────────────────────────────────────── services (multi)

  private serviceKey(sessionId: string, serviceId: string): string {
    return `${sessionId}:${serviceId}`;
  }

  /** In-memory lookup for an additional service of a session. */
  getService(sessionId: string, serviceId: string): Sandbox | undefined {
    return this.registry.getService(sessionId, serviceId);
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
    return this.registry.listServicesForSession(sessionId);
  }

  private runtimePauseTarget(
    sessionId: string,
    serviceId?: string | null,
  ): { sb: Sandbox; serviceId: string | null } {
    return resolveRuntimePauseTarget(this.registry, sessionId, serviceId);
  }

  /** Build the deps bag passed to the runtime-pause module helpers. */
  private get runtimePauseDeps(): RuntimePauseDeps {
    return {
      appendLog: (sb, level, text) => this.appendLog(sb, level, text),
      persistRuntimePauseState: (sid, svc, sb) => this.persistRuntimePauseState(sid, svc, sb),
    };
  }

  /**
   * Like `listServices` but pairs each sandbox with its `serviceId`
   * (recovered from the map key). Consumers that bind services by id
   * — e.g. per-session `SandboxService.serviceBindings` hydration after
   * a server restart — need this to avoid a DB round-trip.
   */
  listServicesWithIds(sessionId: string): Array<{ serviceId: string; sandbox: Sandbox }> {
    return this.registry.listServicesWithIdsForSession(sessionId);
  }

  /**
   * Stand up a secondary container for a session. Three side-effects
   * beyond the normal provision path:
   *   1. Ensures the session's shared docker network exists, attaching
   *      the primary container only when it is currently live.
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
    const driver = await this.resolveDriverOnce();
    return provisionAdditionalServiceFn(req, {
      driver,
      registry: this.registry,
      allocator: this.allocator,
      envStore,
      servicesStore: getServicesStore(),
      maxSandboxes: this.maxSandboxes,
      workdir: this.workdir,
      nodeImage: this.nodeImage,
      devServerPort: this.devServerPort,
      emit: (ev) => this.emit(ev),
      recordStep: (sb, step, message) => this.recordStep(sb, step, message),
      appendLog: (sb, level, text) => this.appendLog(sb, level, text),
      persistService: (sid, svc, name, sb, status) =>
        this.persistService(sid, svc, name, sb, status),
      syncManagedEnvs: (sid) => this.syncManagedEnvs(sid),
      syncEnvsToAllContainers: (sid) => this.syncEnvsToAllContainers(sid),
      destroyService: (sid, svc, reason) => this.destroyService(sid, svc, reason),
      reconcileDeps: this.reconcileDeps,
      externalNodeRuntimeDeps: this.runtimeStateDeps,
      ensureSessionNetwork,
      attachContainerToSessionNetwork,
    });
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
    return captureContainerDiagnosticFn(driver, containerId);
  }

  /**
   * Refresh the "managed" env vars (PREVIEW_URL_* / SERVICE_URL_* /
   * PLAYWRIGHT_BASE_URL_* / MCP_PREVIEW_COOKIE). Body extracted to
   * `manager/managed-envs.ts` — this is a thin coordinator.
   */
  syncManagedEnvs(sessionId: string): void {
    syncManagedEnvsFn(sessionId, {
      envStore,
      getPrimary: (sid) => this.sandboxes.get(sid),
      listServices: (sid) => this.listServices(sid),
      qaPreviewConfig,
      qaRuntime: getResolvedRuntime(),
    });
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
    const body = renderDotEnv(resolveSessionEnvs(sessionId));
    const targets = collectEnvSyncTargets(
      this.sandboxes.get(sessionId),
      this.listServices(sessionId),
    );
    await pushEnvsToContainers(targets, body, this.driver);
  }

  /** Tear down a secondary service. Primary sandbox is untouched. */
  async destroyService(
    sessionId: string,
    serviceId: string,
    reason = 'explicit',
  ): Promise<void> {
    return executeServiceDestroy(sessionId, serviceId, reason, {
      driver: this.driver,
      registry: this.registry,
      allocator: this.allocator,
      servicesStore: getServicesStore(),
      emit: (event) => this.emit(event),
      syncManagedEnvs: (sid) => this.syncManagedEnvs(sid),
      syncEnvsToAllContainers: (sid) => this.syncEnvsToAllContainers(sid),
      destroySessionNetwork: (sid) => destroySessionNetwork(sid),
    });
  }

  // ────────────────────────────────────────────────── attached services
  //
  // "Attached" services reference a Podman/Docker container that lives
  // outside the platform's lifecycle. The user runs `podman run` for it
  // by hand; we only inspect to surface its real status and let the
  // session's agents `exec` into it via the same driver. Start, stop,
  // pause, restart, rebuild and destroy are all bypassed — clicking
  // delete just drops the row and leaves the container alone.

  /**
   * Resolve the live Podman/Docker state of an externally-managed
   * container and return a status snapshot suitable for the in-memory
   * Sandbox entry and the persisted row.
   */
  /**
   * Thin wrapper — the real logic moved to `manager/attached.ts` so the
   * inspect → state mapping is unit-testable independent of the manager.
   */
  private async resolveAttachedState(
    driver: ISandboxDriver,
    containerRef: string,
  ): Promise<AttachedState> {
    return resolveAttachedStateFn(driver, containerRef);
  }

  /**
   * Bind an existing user-managed container to a session as a service.
   * The platform never starts/stops/destroys the container — only the
   * row is owned by the session. Idempotent on `serviceId`: a second
   * call rebinds to a (possibly new) container ref.
   */
  async attachExternalService(req: {
    sessionId: string;
    serviceId: string;
    containerRef: string;
    name?: string;
    hostname?: string;
  }): Promise<Sandbox> {
    const driver = await this.resolveDriverOnce();
    const sb = await buildAttachedServiceSandbox(req, {
      driver,
      servicesStore: getServicesStore(),
      toPersistedStatus: (s) => this.toPersistedStatus(s),
    });
    this.services.set(this.serviceKey(req.sessionId, req.serviceId), sb);
    this.emit({ kind: 'ready', sandboxId: sb.id, previewUrl: '' });
    return sb;
  }

  /**
   * Re-inspect an attached container and update its in-memory + DB
   * status. Returns the refreshed Sandbox. Throws when the row is not
   * an attached service (callers should branch on `is_attached` first).
   */
  async refreshAttachedService(sessionId: string, serviceId: string): Promise<Sandbox> {
    const driver = await this.resolveDriverOnce();
    return refreshAttachedServiceFn(sessionId, serviceId, {
      driver,
      registry: this.registry,
      servicesStore: getServicesStore(),
      toPersistedStatus: (s) => this.toPersistedStatus(s),
    });
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
    this.persister.persistService(sessionId, serviceId, name, sb, statusOverride);
  }

  // ─────────────────────────────────────────────────────────── provision

  /**
   * Create (or return the existing) sandbox for `sessionId`. Idempotent
   * on the happy path — calling twice with the same id while the first
   * call is still provisioning awaits that first call instead of
   * racing a second container into existence.
   */
  async provision(req: ProvisionRequest): Promise<Sandbox> {
    const driver = await this.resolveDriverOnce();
    return provisionPrimarySandbox(req, {
      driver,
      registry: this.registry,
      allocator: this.allocator,
      envStore,
      maxSandboxes: this.maxSandboxes,
      workdir: this.workdir,
      nodeImage: this.nodeImage,
      devServerPort: this.devServerPort,
      buildPreviewUrl: this.buildPreviewUrl,
      emit: (ev) => this.emit(ev),
      recordStep: (sb, step, message) => this.recordStep(sb, step, message),
      appendLog: (sb, level, text) => this.appendLog(sb, level, text),
      persist: (sb, statusOverride) => this.persist(sb, statusOverride),
      syncManagedEnvs: (sid) => this.syncManagedEnvs(sid),
      destroyInternal: (sid, reason) => this.destroyInternal(sid, reason),
      resumeSandbox: (sid) => this.resumeSandbox(sid),
      listServices: (sid) => this.listServices(sid),
      reconcileDeps: this.reconcileDeps,
      externalNodeRuntimeDeps: this.runtimeStateDeps,
      ensureSessionNetwork,
      attachContainerToSessionNetwork,
    });
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
  /** Bundle the dev-server lifecycle deps from this manager instance. */
  private get devLifecycleDeps(): DevLifecycleDeps {
    return {
      registry: this.registry,
      getDriver: () => this.driver,
      resolveDriverOnce: () => this.resolveDriverOnce(),
      reservePort: (p) => this.reservePort(p),
      releasePort: (p) => this.allocator.release(p),
      devServerPort: this.devServerPort,
      appendLog: (sb, level, text) => this.appendLog(sb, level, text),
      emit: (ev) => this.emit(ev),
      recordStep: (sb, step, message) => this.recordStep(sb, step, message),
      persist: (sb, statusOverride) => this.persist(sb, statusOverride),
      persistService: (sid, svc, name, sb, status) => this.persistService(sid, svc, name, sb, status),
      syncManagedEnvs: (sid) => this.syncManagedEnvs(sid),
      syncEnvsToAllContainers: (sid) => this.syncEnvsToAllContainers(sid),
      unpauseRuntimeContainer: (sid, svc) => this.unpauseRuntimeContainer(sid, svc),
      externalNodeRuntimeDeps: this.runtimeStateDeps,
    };
  }

  async restartDevServer(sessionId: string): Promise<void> {
    return restartDevServerFn(sessionId, this.devLifecycleDeps);
  }

  async pauseRuntimeContainer(sessionId: string, serviceId?: string | null): Promise<Sandbox> {
    const { sb, serviceId: resolved } = this.runtimePauseTarget(sessionId, serviceId);
    const driver = await this.resolveDriverOnce();
    return runtimePauseContainer(sessionId, resolved, sb, driver, this.runtimePauseDeps);
  }

  async unpauseRuntimeContainer(sessionId: string, serviceId?: string | null): Promise<Sandbox> {
    const { sb, serviceId: resolved } = this.runtimePauseTarget(sessionId, serviceId);
    const driver = await this.resolveDriverOnce();
    const out = await runtimeUnpauseContainer(sessionId, resolved, sb, driver, this.runtimePauseDeps);
    this.emit({ kind: 'ready', sandboxId: out.id, previewUrl: out.previewUrl });
    return out;
  }

  private async recoverDevServer(sb: Sandbox): Promise<void> {
    return recoverDevServerFn(sb, this.devLifecycleDeps);
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
    return archiveSandboxWorkdir(this.sandboxes.get(sessionId), this.driver);
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
    return pauseSandboxFn(sessionId, reason, this.devLifecycleDeps);
  }

  async resumeSandbox(sessionId: string): Promise<Sandbox> {
    return resumeSandboxFn(sessionId, this.devLifecycleDeps);
  }

  async startServiceContainer(sessionId: string, serviceId: string): Promise<Sandbox> {
    return startServiceContainerFn(sessionId, serviceId, this.devLifecycleDeps);
  }

  async destroy(sessionId: string, reason = 'explicit'): Promise<void> {
    await this.destroyInternal(sessionId, reason);
  }

  async destroyAll(reason = 'shutdown'): Promise<void> {
    return destroyAllSandboxes(reason, {
      primaryIds: () => [...this.sandboxes.keys()],
      serviceKeys: () => [...this.services.keys()],
      destroyService: (sid, svcId, r) => this.destroyService(sid, svcId, r),
      destroyPrimary: (sid, r) => this.destroyInternal(sid, r),
      stopReaper: () => this.stopReaper(),
      setShuttingDown: (v) => { this.shuttingDown = v; },
    });
  }

  // ────────────────────────────────────────────────────────────── internals

  /**
   * Update the sandbox's `step` + log the transition. This is the one
   * writer for `step`; everything else reads it. The emit is a separate
   * event so UIs that prefer SSE can react without re-polling.
   */
  private recordStep(sb: Sandbox, step: SandboxStep, message: string): void {
    this.bus.recordStep(sb, step, message);
  }

  private appendLog(sb: Sandbox, level: SandboxLogLine['level'], text: string): void {
    this.bus.appendLog(sb, level, text);
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
      // Keep driver resolution side-effect-light. Project container
      // recovery is intentionally targeted by session/service when the
      // user takes an action; otherwise starting the server would scan
      // every persisted project container.
    }
    return this.driver;
  }

  /** Bundle the reconcile module's deps from this manager instance. */
  private get reconcileDeps(): ReconcileDeps {
    return {
      registry: this.registry,
      store: getStore(),
      servicesStore: getServicesStore(),
      reservePort: (p) => this.reservePort(p),
      releasePort: (p) => this.allocator.release(p),
      buildPrimaryOpts: {
        devServerPort: this.devServerPort,
        buildPreviewUrl: this.buildPreviewUrl,
      },
      buildServiceOpts: { devServerPort: this.devServerPort },
      toPersistedStatus: (s) => this.toPersistedStatus(s),
    };
  }

  async reconcileSessionFromDb(sessionId: string): Promise<Sandbox | undefined> {
    const driver = await this.resolveDriverOnce();
    await reconcilePrimaryForSession(driver, sessionId, this.reconcileDeps);
    await reconcileServicesForSession(driver, sessionId, this.reconcileDeps);
    return this.sandboxes.get(sessionId);
  }

  async reconcileServiceFromDb(sessionId: string, serviceId: string): Promise<Sandbox | undefined> {
    const driver = await this.resolveDriverOnce();
    const result = await reconcileServiceForSession(driver, sessionId, serviceId, this.reconcileDeps);
    return result?.sandbox ?? undefined;
  }

  /** Boot-time full reconciliation — drives both primary + service rows. */
  private async reconcileFromDb(driver: ISandboxDriver): Promise<void> {
    await reconcileAllPrimaryFromDb(driver, this.reconcileDeps);
    await reconcileAllServicesFromDb(driver, this.reconcileDeps);
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
    return parseLimits(limitsJson);
  }

  private toPersistedStatus(status: SandboxStatus): PersistedSandboxStatus {
    return toPersistedStatus(status);
  }

  private persist(sb: Sandbox, statusOverride?: PersistedSandboxStatus): void {
    this.persister.persist(sb, statusOverride);
  }

  private persistRuntimePauseState(
    sessionId: string,
    serviceId: string | null,
    sb: Sandbox,
  ): void {
    this.persister.persistRuntimePauseState(sessionId, serviceId, sb);
  }

  private async reapOrphans(
    driver: ISandboxDriver,
    keepAlive: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    return reapOrphansFn({
      driver,
      registry: this.registry,
      store: getStore(),
      servicesStore: getServicesStore(),
      keepAlive,
    });
  }

  private async destroyInternal(sessionId: string, reason: string): Promise<void> {
    return destroySandboxInternal(sessionId, reason, {
      driver: this.driver,
      registry: this.registry,
      allocator: this.allocator,
      store: getStore(),
      emit: (ev) => this.emit(ev),
    });
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
    return prepareWorkdirFn(driver, containerId, workdir, isolationUser);
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
  private resolveExternalNodeDevSpec(
    hostWorkdirMount: string,
    stack: SandboxStack,
    portOverride?: number,
  ): ExternalNodeDevSpec {
    return resolveExternalNodeDevSpecFn(hostWorkdirMount, stack, portOverride, this.devServerPort);
  }

  // The pure inference helpers below moved to `manager/external-node.ts`
  // so they can be unit-tested without the manager singleton. Each private
  // method here is a thin wrapper that forwards to the named function;
  // call sites inside this class were not updated to keep the diff small.
  private inferExternalNodeScriptPort(scriptBody: string): number | null {
    return inferExternalNodeScriptPortFn(scriptBody);
  }

  private inferExternalNodeFramework(
    stack: SandboxStack,
    scriptBody: string,
  ): ExternalNodeFramework {
    return inferExternalNodeFrameworkFn(stack, scriptBody);
  }

  private inferExternalNodePort(framework: ExternalNodeFramework): number {
    return inferExternalNodePortFn(framework, this.devServerPort);
  }

  private externalNodeInstallCommand(pm: NodePackageManager): string {
    return externalNodeInstallCommandFn(pm);
  }

  private externalNodeRunArgs(spec: ExternalNodeDevSpec, previewPathPrefix: string): string {
    return externalNodeRunArgsFn(spec, previewPathPrefix);
  }

  private externalNodeRunCommand(spec: ExternalNodeDevSpec, previewPathPrefix: string): string {
    return externalNodeRunCommandFn(spec, previewPathPrefix);
  }

  private externalNodeDependencyProbeCommand(): string {
    return externalNodeDependencyProbeCommandFn();
  }

  private async ensureExternalNodeDependencies(
    driver: ISandboxDriver,
    sb: Sandbox,
    spec: ExternalNodeDevSpec,
    signal?: AbortSignal,
  ): Promise<void> {
    return ensureExternalNodeDependenciesFn(driver, sb, spec, this.runtimeStateDeps, signal);
  }

  private async startExternalNodeDevServer(
    driver: ISandboxDriver,
    sb: Sandbox,
    spec: ExternalNodeDevSpec,
    signal?: AbortSignal,
  ): Promise<void> {
    return startExternalNodeDevServerFn(driver, sb, spec, this.runtimeStateDeps, signal);
  }

  /** Bundle deps used by the external-node / dev-server runtime helpers. */
  private get runtimeStateDeps() {
    return {
      appendLog: (sb: Sandbox, level: 'info' | 'error', text: string) => this.appendLog(sb, level, text),
      recordStep: (sb: Sandbox, step: Sandbox['step'], message: string) =>
        this.recordStep(sb, step, message),
    };
  }

  private buildDevServerCommand(stack: SandboxStack): string {
    return buildDevServerCommandFn(stack, this.devServerPort);
  }

  private async relaunchDevServer(
    driver: ISandboxDriver,
    containerId: string,
    workdir: string,
    signal?: AbortSignal,
    stack: SandboxStack = 'react-ts',
  ): Promise<void> {
    return relaunchDevServerFn(driver, containerId, workdir, stack, this.devServerPort, signal);
  }

  private async waitForPublishedHttp(
    driver: ISandboxDriver,
    sb: Sandbox,
    path: string,
    signal?: AbortSignal,
    label = 'Project container',
    timeoutMs = 120_000,
  ): Promise<void> {
    return waitForPublishedHttpFn(driver, sb, path, { signal, label, timeoutMs });
  }

  private async readDevServerLog(
    driver: ISandboxDriver,
    sb: Sandbox,
    lines: number,
  ): Promise<string> {
    return readDevServerLogFn(driver, sb, lines);
  }

  private devServerLogLooksReady(log: string): boolean {
    return devServerLogLooksReadyFn(log);
  }

  private startStatsSampler(): void {
    if (this.statsTimer) return;
    this.statsTimer = startStatsSampler(this.statsIntervalMs, {
      getDriver: () => this.driver,
      listSandboxes: () => this.sandboxes.values(),
      emit: (ev) => this.emit(ev),
      isShuttingDown: () => this.shuttingDown,
    });
  }

  private startReaper(): void {
    if (this.reaperTimer) return;
    this.reaperTimer = startReaperLoop({
      listSandboxes: () => this.sandboxes.values(),
      getStore: () => getStore(),
      resolveDriverOnce: () => this.resolveDriverOnce(),
      pauseSandbox: (sid, reason) => this.pauseSandbox(sid, reason),
      destroyInternal: (sid, reason) => this.destroyInternal(sid, reason),
      isShuttingDown: () => this.shuttingDown,
      pauseTtlMs: this.pauseTtlMs,
      destroyAfterPauseMs: this.destroyAfterPauseMs,
    });
  }

  private stopReaper(): void {
    this.reaperTimer?.stop();
    this.reaperTimer = null;
    this.statsTimer?.stop();
    this.statsTimer = null;
  }

  private installShutdownHandlers(): void {
    installShutdownHandlersImpl({
      countSandboxes: () => this.sandboxes.size,
      destroyAll: (reason) => this.destroyAll(reason),
    });
  }
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
