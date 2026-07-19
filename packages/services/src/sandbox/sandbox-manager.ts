/**
 * SandboxManager — owns the lifecycle of per-session sandboxes.
 *
 * Public API. Implementation is delegated to sub-modules under `./manager/`
 * (heavy lifting) and `./sandbox-manager/` (types, module state, network
 * helpers, deps-bag builders). This file wires everything together.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PortAllocator, defaultPortAllocator } from './port-allocator.js';
import type { ISandboxDriver } from './ports/sandbox-driver.js';
import type {
  Sandbox,
  SandboxEvent,
  SandboxLogLine,
  SandboxObserver,
  SandboxStep,
} from './types.js';

import { resolveDriver, getResolvedRuntime } from './drivers/driver-factory.js';
import { CliOciDriver } from './drivers/cli-oci-driver.js';

import { defaultPreviewUrl } from './manager/util/preview-url.js';
import { sessionNetworkName } from './manager/util/naming.js';
import { renderDotEnv } from './manager/io/env-helpers.js';
import { sandboxStores } from './manager/state/stores.js';
import { SandboxRegistry } from './manager/state/registry.js';
import { SandboxEventBus } from './manager/events/event-bus.js';
import { SandboxPersister, toPersistedStatus } from './manager/persistence/persister.js';
import { WorkspaceIO } from './manager/io/workspace-io.js';
import { IntervalTimer } from './manager/reaper/interval-timer.js';
import { installShutdownHandlers as installShutdownHandlersImpl } from './manager/runtime/shutdown.js';
import { buildAttachedServiceSandbox, refreshAttachedService as refreshAttachedServiceFn } from './manager/attached.js';
import { collectEnvSyncTargets, pushEnvsToContainers } from './manager/env-sync.js';
import { syncManagedEnvs as syncManagedEnvsFn } from './manager/managed-envs.js';
import { destroyAllSandboxes, destroySandboxInternal } from './manager/destroy-sandbox.js';
import { provisionAdditionalService as provisionAdditionalServiceFn } from './manager/provision-service.js';
import { provisionPrimarySandbox } from './manager/provision-primary.js';
import {
  resolveRuntimePauseTarget,
  runtimePauseContainer,
  runtimeUnpauseContainer,
} from './manager/runtime-pause.js';
import { executeServiceDestroy } from './manager/destroy-service.js';
import { reconcilePrimaryForSession, reconcileServicesForSession, reconcileServiceForSession } from './manager/reconcile.js';
import { startStatsSampler } from './manager/stats-sampler.js';
import { startReaperLoop } from './manager/reaper-loop.js';
import { archiveSandboxWorkdir } from './manager/archive-sandbox.js';
import {
  pauseSandbox as pauseSandboxFn,
  restartDevServer as restartDevServerFn,
  restartDevServerForService as restartDevServerForServiceFn,
  resumeSandbox as resumeSandboxFn,
  startServiceContainer as startServiceContainerFn,
} from './manager/dev-lifecycle.js';

import {
  DEFAULT_DEV_PORT,
  DEFAULT_IDLE_TTL,
  DEFAULT_MAX,
  DEFAULT_NODE_IMAGE,
  DEFAULT_WORKDIR,
  type ProvisionRequest,
  type ProvisionServiceRequest,
  type SandboxManagerOptions,
} from './sandbox-manager/types.js';
import { getEnvStore, getServicesStore, getStore, resolveSessionEnvs } from './sandbox-manager/module-state.js';
import { attachContainerToSessionNetwork, destroySessionNetwork, ensureSessionNetwork } from './sandbox-manager/network.js';
import {
  type ManagerHooks,
  buildDestroyServiceDeps,
  buildDevLifecycleDeps,
  buildProvisionPrimaryDeps,
  buildProvisionServiceDeps,
  buildReconcileDeps,
  buildRuntimePauseDeps,
  buildSyncManagedEnvsDeps,
} from './sandbox-manager/deps-builders.js';

// Re-exports preserved for external consumers.
export { sessionNetworkName };
export { cleanupSessionPersistence } from './manager/persistence/cleanup.js';
export {
  setCompanySandboxStore,
  setCompanySandboxServicesStore,
  setCompanySessionEnvStore,
  setQaPreviewConfig,
} from './sandbox-manager/module-state.js';
export { ensureSessionNetwork, destroySessionNetwork, attachContainerToSessionNetwork };
export type { ProvisionRequest, ProvisionServiceRequest, SandboxManagerOptions };

export class SandboxManager {
  private readonly registry = new SandboxRegistry();
  private readonly bus = new SandboxEventBus();
  private readonly persister = new SandboxPersister(sandboxStores);
  private readonly workspaceIO = new WorkspaceIO(this.registry, () => this.driver);
  private readonly allocator: PortAllocator;
  private get sandboxes(): Map<string, Sandbox> { return this.registry.primary; }
  private get services(): Map<string, Sandbox> { return this.registry.services; }
  private driver: ISandboxDriver | null;
  private readonly maxSandboxes: number;
  private readonly pauseTtlMs: number;
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
    const idleTtl = options.idleTtlMs ?? Number(process.env.MCP_SANDBOX_IDLE_MS ?? DEFAULT_IDLE_TTL);
    this.pauseTtlMs = Number(process.env.MCP_SANDBOX_PAUSE_AFTER_MS ?? idleTtl);
    this.destroyAfterPauseMs = Number(process.env.MCP_SANDBOX_DESTROY_AFTER_PAUSE_MS ?? 24 * 60 * 60 * 1000);
    this.nodeImage = options.nodeImage ?? DEFAULT_NODE_IMAGE;
    this.devServerPort = options.devServerPort ?? DEFAULT_DEV_PORT;
    this.workdir = options.workdir ?? DEFAULT_WORKDIR;
    this.buildPreviewUrl = options.buildPreviewUrl ?? defaultPreviewUrl;
    this.statsIntervalMs = options.statsIntervalMs ?? Number(process.env.MCP_SANDBOX_STATS_MS ?? 15_000);
    this.startReaper();
    this.startStatsSampler();
    if (!options.skipShutdownHandlers) this.installShutdownHandlers();
  }

  private get hooks(): ManagerHooks {
    return {
      driver: this.driver,
      registry: this.registry,
      persister: this.persister,
      allocator: this.allocator,
      devServerPort: this.devServerPort,
      buildPreviewUrl: this.buildPreviewUrl,
      emit: (ev) => this.bus.emit(ev),
      recordStep: (sb, step, message) => this.bus.recordStep(sb, step, message),
      appendLog: (sb, level, text) => this.bus.appendLog(sb, level, text),
      resolveDriverOnce: () => this.resolveDriverOnce(),
      reservePort: (p) => this.reservePort(p),
      destroyInternal: (sid, reason) => this.destroyInternal(sid, reason),
      syncManagedEnvs: (sid) => this.syncManagedEnvs(sid),
      syncEnvsToAllContainers: (sid) => this.syncEnvsToAllContainers(sid),
      resumeSandbox: (sid) => this.resumeSandbox(sid),
      unpauseRuntimeContainer: (sid, svc) => this.unpauseRuntimeContainer(sid, svc),
      listServices: (sid) => this.listServices(sid),
      destroyService: (sid, svc, reason) => this.destroyService(sid, svc, reason),
    };
  }

  // ─── Observers / Queries ───────────────────────────────────────
  subscribe(observer: SandboxObserver): () => void { return this.bus.subscribe(observer); }
  get(sessionId: string): Sandbox | undefined { return this.sandboxes.get(sessionId); }
  list(): Sandbox[] { return [...this.sandboxes.values()]; }

  // ─── Workspace I/O ─────────────────────────────────────────────
  async readWorkspaceFile(sessionId: string, relPath: string): Promise<string | null> { return this.workspaceIO.readText(sessionId, relPath); }
  async writeWorkspaceFile(sessionId: string, relPath: string, data: string): Promise<void> { return this.workspaceIO.writeText(sessionId, relPath, data); }
  async readWorkspaceFileBuffer(sessionId: string, relPath: string, opts?: { maxBytes?: number }): Promise<Buffer> { return this.workspaceIO.readBuffer(sessionId, relPath, opts); }
  async readWorkspaceFileBufferOnService(sessionId: string, serviceId: string | undefined, relPath: string, opts?: { maxBytes?: number }): Promise<Buffer> { return this.workspaceIO.readBufferOnService(sessionId, serviceId, relPath, opts); }
  async listWorkspaceFilesOnService(sessionId: string, serviceId: string | undefined, relDir: string): Promise<string[]> { return this.workspaceIO.listFilesOnService(sessionId, serviceId, relDir); }
  async removeWorkspaceDirOnService(sessionId: string, serviceId: string | undefined, relDir: string): Promise<void> { return this.workspaceIO.removeDirOnService(sessionId, serviceId, relDir); }
  async readWorkspaceFileOnService(sessionId: string, serviceId: string | undefined, relPath: string): Promise<string | null> { return this.workspaceIO.readTextOnService(sessionId, serviceId, relPath); }

  // ─── Services (multi-container per session) ────────────────────
  private serviceKey(sessionId: string, serviceId: string): string { return `${sessionId}:${serviceId}`; }
  getService(sessionId: string, serviceId: string): Sandbox | undefined { return this.registry.getService(sessionId, serviceId); }
  resolveContainerId(sessionId: string, serviceId?: string | null): string | null {
    if (!serviceId || serviceId === 'main') return this.sandboxes.get(sessionId)?.containerId ?? null;
    return this.services.get(this.serviceKey(sessionId, serviceId))?.containerId ?? null;
  }
  listServices(sessionId: string): Sandbox[] { return this.registry.listServicesForSession(sessionId); }
  listServicesWithIds(sessionId: string): Array<{ serviceId: string; sandbox: Sandbox }> { return this.registry.listServicesWithIdsForSession(sessionId); }

  async provisionAdditionalService(req: ProvisionServiceRequest): Promise<Sandbox> {
    await this.resolveDriverOnce();
    return provisionAdditionalServiceFn(req, buildProvisionServiceDeps(this.hooks, this.maxSandboxes, this.workdir, this.nodeImage));
  }
  syncManagedEnvs(sessionId: string): void {
    syncManagedEnvsFn(sessionId, buildSyncManagedEnvsDeps(this.hooks, getResolvedRuntime()));
  }
  async syncEnvsToAllContainers(sessionId: string): Promise<void> {
    // D1: each container gets a body rendered for ITS service id, so
    // `service_scope` vars only land where they belong ('main' = primary).
    const targets = collectEnvSyncTargets(this.sandboxes.get(sessionId), this.listServicesWithIds(sessionId));
    await pushEnvsToContainers(targets, (serviceId) => renderDotEnv(resolveSessionEnvs(sessionId, serviceId)), this.driver);
  }
  async destroyService(sessionId: string, serviceId: string, reason = 'explicit'): Promise<void> {
    return executeServiceDestroy(sessionId, serviceId, reason, buildDestroyServiceDeps(this.hooks));
  }

  // ─── Attached (externally-managed) services ────────────────────
  async attachExternalService(req: { sessionId: string; serviceId: string; containerRef: string; name?: string; hostname?: string }): Promise<Sandbox> {
    const driver = await this.resolveDriverOnce();
    const sb = await buildAttachedServiceSandbox(req, { driver, servicesStore: getServicesStore(), toPersistedStatus: (s) => toPersistedStatus(s) });
    this.services.set(this.serviceKey(req.sessionId, req.serviceId), sb);
    this.bus.emit({ kind: 'ready', sandboxId: sb.id, previewUrl: '' });
    return sb;
  }
  async refreshAttachedService(sessionId: string, serviceId: string): Promise<Sandbox> {
    const driver = await this.resolveDriverOnce();
    return refreshAttachedServiceFn(sessionId, serviceId, { driver, registry: this.registry, servicesStore: getServicesStore(), toPersistedStatus: (s) => toPersistedStatus(s) });
  }

  // ─── Provision / lifecycle ─────────────────────────────────────
  async provision(req: ProvisionRequest): Promise<Sandbox> {
    await this.resolveDriverOnce();
    return provisionPrimarySandbox(req, buildProvisionPrimaryDeps(this.hooks, this.maxSandboxes, this.workdir, this.nodeImage));
  }
  async restartDevServer(sessionId: string): Promise<void> { return restartDevServerFn(sessionId, buildDevLifecycleDeps(this.hooks)); }
  async restartService(sessionId: string, serviceId: string): Promise<void> { return restartDevServerForServiceFn(sessionId, serviceId, buildDevLifecycleDeps(this.hooks)); }
  async pauseRuntimeContainer(sessionId: string, serviceId?: string | null): Promise<Sandbox> {
    const { sb, serviceId: resolved } = resolveRuntimePauseTarget(this.registry, sessionId, serviceId);
    const driver = await this.resolveDriverOnce();
    return runtimePauseContainer(sessionId, resolved, sb, driver, buildRuntimePauseDeps(this.hooks));
  }
  async unpauseRuntimeContainer(sessionId: string, serviceId?: string | null): Promise<Sandbox> {
    const { sb, serviceId: resolved } = resolveRuntimePauseTarget(this.registry, sessionId, serviceId);
    const driver = await this.resolveDriverOnce();
    const out = await runtimeUnpauseContainer(sessionId, resolved, sb, driver, buildRuntimePauseDeps(this.hooks));
    this.bus.emit({ kind: 'ready', sandboxId: out.id, previewUrl: out.previewUrl });
    return out;
  }
  async archive(sessionId: string): Promise<Buffer | null> { return archiveSandboxWorkdir(this.sandboxes.get(sessionId), this.driver); }
  touch(sessionId: string): void {
    const sb = this.sandboxes.get(sessionId);
    if (sb) sb.lastAccessAt = Date.now();
  }
  async pauseSandbox(sessionId: string, reason = 'idle-ttl'): Promise<void> { return pauseSandboxFn(sessionId, reason, buildDevLifecycleDeps(this.hooks)); }
  async resumeSandbox(sessionId: string): Promise<Sandbox> { return resumeSandboxFn(sessionId, buildDevLifecycleDeps(this.hooks)); }
  async startServiceContainer(sessionId: string, serviceId: string): Promise<Sandbox> { return startServiceContainerFn(sessionId, serviceId, buildDevLifecycleDeps(this.hooks)); }
  async destroy(sessionId: string, reason = 'explicit'): Promise<void> { await this.destroyInternal(sessionId, reason); }
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

  // ─── Reconcile ─────────────────────────────────────────────────
  async reconcileSessionFromDb(sessionId: string): Promise<Sandbox | undefined> {
    const driver = await this.resolveDriverOnce();
    const deps = buildReconcileDeps(this.hooks);
    await reconcilePrimaryForSession(driver, sessionId, deps);
    await reconcileServicesForSession(driver, sessionId, deps);
    return this.sandboxes.get(sessionId);
  }
  async reconcileServiceFromDb(sessionId: string, serviceId: string): Promise<Sandbox | undefined> {
    const driver = await this.resolveDriverOnce();
    const result = await reconcileServiceForSession(driver, sessionId, serviceId, buildReconcileDeps(this.hooks));
    return result?.sandbox ?? undefined;
  }

  // ─── Internals ─────────────────────────────────────────────────
  private async resolveDriverOnce(): Promise<ISandboxDriver> {
    if (!this.driver) {
      this.driver = await resolveDriver();
      // Ensure the sandbox base image is available locally. For CLI drivers
      // (Docker/Podman) this is a no-op when the image already exists; on a
      // fresh host it builds it automatically.
      if (this.driver instanceof CliOciDriver) {
        const buildCtx = join(dirname(fileURLToPath(import.meta.url)), '../../../docker/sandbox-node');
        await this.driver.ensureImage(this.nodeImage, buildCtx).catch((e) =>
          console.warn(`[sandbox-manager] image ensure failed (will retry on first sandbox): ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    }
    return this.driver;
  }
  private async reservePort(port: number): Promise<void> {
    // Can't call allocator.acquire() — port is ALREADY in use by a running
    // container. Reach into the internal set; reconcile's whole job is to
    // mirror state that lives outside the allocator's world.
    const alloc = this.allocator as unknown as { inUse: Set<number> };
    alloc.inUse?.add(port);
  }
  private async destroyInternal(sessionId: string, reason: string): Promise<void> {
    return destroySandboxInternal(sessionId, reason, {
      driver: this.driver, registry: this.registry, allocator: this.allocator, store: getStore(),
      emit: (ev) => this.bus.emit(ev),
    });
  }

  // ─── Reaper / stats / shutdown ─────────────────────────────────
  private startStatsSampler(): void {
    if (this.statsTimer) return;
    this.statsTimer = startStatsSampler(this.statsIntervalMs, {
      getDriver: () => this.driver,
      listSandboxes: () => this.sandboxes.values(),
      emit: (ev) => this.bus.emit(ev),
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
    this.reaperTimer?.stop(); this.reaperTimer = null;
    this.statsTimer?.stop(); this.statsTimer = null;
  }
  private installShutdownHandlers(): void {
    installShutdownHandlersImpl({
      countSandboxes: () => this.sandboxes.size,
      destroyAll: (reason) => this.destroyAll(reason),
    });
  }
}

// Process-wide singleton, lazily created. Tests can call
// `setSandboxManagerForTests(new SandboxManager({ driver }))` before any
// consumer grabs the default.
let singleton: SandboxManager | null = null;

export function getSandboxManager(): SandboxManager {
  // The application entrypoints own SIGINT/SIGTERM and call destroyAll as one
  // phase of their coordinated shutdown. Installing another process.exit()
  // handler here races worker/database flushes and can cut them off early.
  if (!singleton) singleton = new SandboxManager({ skipShutdownHandlers: true });
  return singleton;
}

/** Read the singleton during shutdown without creating timers/handlers late. */
export function tryGetSandboxManager(): SandboxManager | null {
  return singleton;
}

export function setSandboxManagerForTests(manager: SandboxManager | null): void {
  singleton = manager;
}
