import type { PortAllocator } from '../port-allocator.js';
import type { ISandboxDriver } from '../ports/sandbox-driver.js';
import type { Sandbox, SandboxEvent, SandboxLogLine, SandboxStep, SandboxStatus } from '../types.js';
import type { PersistedSandboxStatus } from '@mcp/store/company-sandbox-store.js';
import type { SandboxRegistry } from '../manager/state/registry.js';
import type { SandboxPersister } from '../manager/persistence/persister.js';
import { toPersistedStatus } from '../manager/persistence/persister.js';
import type { ReconcileDeps } from '../manager/reconcile.js';
import type { DevLifecycleDeps } from '../manager/dev-lifecycle.js';
import type { RuntimePauseDeps } from '../manager/runtime-pause.js';
import {
  attachContainerToSessionNetwork,
  destroySessionNetwork,
  ensureSessionNetwork,
} from './network.js';
import { getEnvStore, getQaPreviewConfig, getServicesStore, getStore } from './module-state.js';

/**
 * Methods the manager exposes (or wraps) to its delegated sub-modules.
 * Centralising the shape here keeps the deps-bag builders unambiguous and
 * avoids ~80 LOC of duplicated inline-object construction in the manager.
 */
export interface ManagerHooks {
  driver: ISandboxDriver | null;
  registry: SandboxRegistry;
  persister: SandboxPersister;
  allocator: PortAllocator;
  devServerPort: number;
  buildPreviewUrl: (sessionId: string, hostPort: number) => string;
  emit: (event: SandboxEvent) => void;
  recordStep: (sb: Sandbox, step: SandboxStep, message: string) => void;
  appendLog: (sb: Sandbox, level: SandboxLogLine['level'], text: string) => void;
  resolveDriverOnce: () => Promise<ISandboxDriver>;
  reservePort: (port: number) => Promise<void>;
  destroyInternal: (sessionId: string, reason: string) => Promise<void>;
  syncManagedEnvs: (sessionId: string) => Promise<void>;
  syncEnvsToAllContainers: (sessionId: string) => Promise<void>;
  resumeSandbox: (sessionId: string) => Promise<Sandbox>;
  unpauseRuntimeContainer: (sessionId: string, serviceId?: string | null) => Promise<Sandbox>;
  listServices: (sessionId: string) => Sandbox[];
  destroyService: (sessionId: string, serviceId: string, reason: string) => Promise<void>;
}

export function buildReconcileDeps(h: ManagerHooks): ReconcileDeps {
  return {
    registry: h.registry,
    store: getStore(),
    servicesStore: getServicesStore(),
    reservePort: (p) => h.reservePort(p),
    releasePort: (p) => h.allocator.release(p),
    buildPrimaryOpts: { devServerPort: h.devServerPort, buildPreviewUrl: h.buildPreviewUrl },
    buildServiceOpts: { devServerPort: h.devServerPort },
    toPersistedStatus: (s: SandboxStatus) => toPersistedStatus(s),
  };
}

export function buildRuntimePauseDeps(h: ManagerHooks): RuntimePauseDeps {
  return {
    appendLog: (sb, level, text) => h.appendLog(sb, level, text),
    persistRuntimePauseState: (sid, svc, sb) => h.persister.persistRuntimePauseState(sid, svc, sb),
  };
}

export function buildRuntimeStateDeps(h: ManagerHooks) {
  return {
    appendLog: (sb: Sandbox, level: 'info' | 'error', text: string) => h.appendLog(sb, level, text),
    recordStep: (sb: Sandbox, step: Sandbox['step'], message: string) => h.recordStep(sb, step, message),
  };
}

export function buildDevLifecycleDeps(h: ManagerHooks): DevLifecycleDeps {
  return {
    registry: h.registry,
    getDriver: () => h.driver,
    resolveDriverOnce: () => h.resolveDriverOnce(),
    reservePort: (p) => h.reservePort(p),
    releasePort: (p) => h.allocator.release(p),
    devServerPort: h.devServerPort,
    appendLog: (sb, level, text) => h.appendLog(sb, level, text),
    emit: (ev) => h.emit(ev),
    recordStep: (sb, step, message) => h.recordStep(sb, step, message),
    persist: (sb, statusOverride) => h.persister.persist(sb, statusOverride),
    persistService: (sid, svc, name, sb, status) => h.persister.persistService(sid, svc, name, sb, status),
    syncManagedEnvs: (sid) => h.syncManagedEnvs(sid),
    syncEnvsToAllContainers: (sid) => h.syncEnvsToAllContainers(sid),
    unpauseRuntimeContainer: (sid, svc) => h.unpauseRuntimeContainer(sid, svc),
    externalNodeRuntimeDeps: buildRuntimeStateDeps(h),
  };
}

export function buildProvisionPrimaryDeps(h: ManagerHooks, maxSandboxes: number, workdir: string, nodeImage: string) {
  return {
    driver: h.driver as ISandboxDriver,
    registry: h.registry,
    allocator: h.allocator,
    envStore: getEnvStore(),
    maxSandboxes, workdir, nodeImage,
    devServerPort: h.devServerPort,
    buildPreviewUrl: h.buildPreviewUrl,
    emit: (ev: SandboxEvent) => h.emit(ev),
    recordStep: (sb: Sandbox, step: SandboxStep, message: string) => h.recordStep(sb, step, message),
    appendLog: (sb: Sandbox, level: SandboxLogLine['level'], text: string) => h.appendLog(sb, level, text),
    persist: (sb: Sandbox, statusOverride?: PersistedSandboxStatus) => h.persister.persist(sb, statusOverride),
    syncManagedEnvs: (sid: string) => h.syncManagedEnvs(sid),
    destroyInternal: (sid: string, reason: string) => h.destroyInternal(sid, reason),
    resumeSandbox: (sid: string) => h.resumeSandbox(sid),
    listServices: (sid: string) => h.listServices(sid),
    reconcileDeps: buildReconcileDeps(h),
    externalNodeRuntimeDeps: buildRuntimeStateDeps(h),
    ensureSessionNetwork,
    attachContainerToSessionNetwork,
  };
}

export function buildProvisionServiceDeps(h: ManagerHooks, maxSandboxes: number, workdir: string, nodeImage: string) {
  return {
    driver: h.driver as ISandboxDriver,
    registry: h.registry,
    allocator: h.allocator,
    envStore: getEnvStore(),
    servicesStore: getServicesStore(),
    maxSandboxes, workdir, nodeImage,
    devServerPort: h.devServerPort,
    emit: (ev: SandboxEvent) => h.emit(ev),
    recordStep: (sb: Sandbox, step: SandboxStep, message: string) => h.recordStep(sb, step, message),
    appendLog: (sb: Sandbox, level: SandboxLogLine['level'], text: string) => h.appendLog(sb, level, text),
    persistService: (sid: string, svc: string, name: string, sb: Sandbox, status?: PersistedSandboxStatus) =>
      h.persister.persistService(sid, svc, name, sb, status),
    syncManagedEnvs: (sid: string) => h.syncManagedEnvs(sid),
    syncEnvsToAllContainers: (sid: string) => h.syncEnvsToAllContainers(sid),
    destroyService: (sid: string, svc: string, reason: string) => h.destroyService(sid, svc, reason),
    reconcileDeps: buildReconcileDeps(h),
    externalNodeRuntimeDeps: buildRuntimeStateDeps(h),
    ensureSessionNetwork,
    attachContainerToSessionNetwork,
  };
}

export function buildDestroyServiceDeps(h: ManagerHooks) {
  return {
    driver: h.driver,
    registry: h.registry,
    allocator: h.allocator,
    servicesStore: getServicesStore(),
    emit: (event: SandboxEvent) => h.emit(event),
    syncManagedEnvs: (sid: string) => h.syncManagedEnvs(sid),
    syncEnvsToAllContainers: (sid: string) => h.syncEnvsToAllContainers(sid),
    destroySessionNetwork: (sid: string) => destroySessionNetwork(sid),
  };
}

export function buildSyncManagedEnvsDeps(h: ManagerHooks, qaRuntime: 'docker' | 'podman' | 'e2b' | null) {
  return {
    envStore: getEnvStore(),
    getPrimary: (sid: string) => h.registry.primary.get(sid),
    listServices: (sid: string) => h.listServices(sid),
    qaPreviewConfig: getQaPreviewConfig(),
    qaRuntime,
  };
}
