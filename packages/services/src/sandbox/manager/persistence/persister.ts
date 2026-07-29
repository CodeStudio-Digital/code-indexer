import type { Sandbox, SandboxStatus, SandboxLimits } from '../../types.js';
import { DEFAULT_SANDBOX_LIMITS } from '../../types.js';
import type { PersistedSandboxStatus } from '@mcp/store/company-sandbox-store.js';
import type { SandboxStoreContainer } from '../state/stores.js';

/**
 * Maps the in-memory sandbox lifecycle (`SandboxStatus`) to the subset
 * persisted in `company_sandbox` / `company_sandbox_services`. Transient
 * values (`pending`, `destroying`) collapse onto their semantically
 * nearest persisted state.
 */
export function toPersistedStatus(status: SandboxStatus): PersistedSandboxStatus {
  if (status === 'pending' || status === 'provisioning') return 'provisioning';
  if (status === 'ready') return 'running';
  if (status === 'paused') return 'paused';
  if (status === 'destroying' || status === 'destroyed') return 'destroying';
  return 'error';
}

/** Parse the JSON-encoded `limits` column merging over defaults. */
export function parseLimits(limitsJson: string): SandboxLimits {
  try {
    const parsed = JSON.parse(limitsJson) as Partial<SandboxLimits>;
    return { ...DEFAULT_SANDBOX_LIMITS, ...parsed };
  } catch {
    return DEFAULT_SANDBOX_LIMITS;
  }
}

/**
 * Owns DB writes for primary sandboxes and secondary services. Reads
 * stores from the injected container so `null`-store paths (tests, CLI)
 * silently no-op instead of throwing.
 */
export class SandboxPersister {
  constructor(private readonly stores: SandboxStoreContainer) {}

  /**
   * Write the current state of a primary sandbox to its session bundle. Called after
   * every transition so a crash/restart can reconstruct.
   */
  persist(sb: Sandbox, statusOverride?: PersistedSandboxStatus): void {
    const store = this.stores.getSandboxStore();
    if (!store) return;
    try {
      store.upsert({
        session_id: sb.id,
        container_id: sb.containerId,
        runtime: sb.runtime,
        stack: sb.stack,
        workdir: sb.workdir,
        host_workdir_mount: sb.hostWorkdirMount ?? null,
        host_port: sb.hostPort,
        limits: sb.limits as unknown as Record<string, unknown>,
        status: statusOverride ?? toPersistedStatus(sb.status),
        error: sb.error ?? null,
        mount_kind: sb.mountKind,
        image_source: sb.imageSource,
        built_image_tag: sb.builtImageTag ?? null,
        dockerfile_path: sb.dockerfilePath ?? null,
        dockerfile_exposed_port: sb.dockerfileExposedPort ?? null,
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
   * Persist a service row mirroring `persist()` for primary sandboxes.
   * Silent when the store is unavailable. Defensively releases stale
   * records that would collide on `container_id` / `host_port` after a
   * previous provisioning crashed mid-flight.
   */
  persistService(
    sessionId: string,
    serviceId: string,
    name: string,
    sb: Sandbox,
    statusOverride?: PersistedSandboxStatus,
  ): void {
    const store = this.stores.getServicesStore();
    if (!store) return;
    try {
      const released = store.releaseStaleContainerId(sb.containerId, sessionId, serviceId);
      if (released > 0) {
        console.warn(
          `[sandbox-manager] persistService ${sessionId}:${serviceId} freed ${released} stale row(s) on container_id=${sb.containerId.slice(0, 12)}`,
        );
      }
      const releasedPort = store.releaseStaleHostPort(sb.hostPort, sessionId, serviceId);
      if (releasedPort > 0) {
        console.warn(
          `[sandbox-manager] persistService ${sessionId}:${serviceId} freed ${releasedPort} stale row(s) on host_port=${sb.hostPort}`,
        );
      }
      store.upsert({
        session_id: sessionId,
        service_id: serviceId,
        name,
        container_id: sb.containerId,
        runtime: sb.runtime,
        stack: sb.stack,
        workdir: sb.workdir,
        host_workdir_mount: sb.hostWorkdirMount ?? null,
        host_port: sb.hostPort,
        limits: sb.limits as unknown as Record<string, unknown>,
        status: statusOverride ?? toPersistedStatus(sb.status),
        error: sb.error ?? null,
        mount_kind: sb.mountKind,
        image_source: sb.imageSource,
        built_image_tag: sb.builtImageTag ?? null,
        dockerfile_path: sb.dockerfilePath ?? null,
        dockerfile_exposed_port: sb.dockerfileExposedPort ?? null,
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

  /**
   * After unpause, mark the persisted row as running. For services we
   * patch the row directly (we don't have an upsert payload at hand);
   * for primaries we call `persist()` with an explicit override so the
   * `paused_at_ms` column is cleared.
   */
  persistRuntimePauseState(
    sessionId: string,
    serviceId: string | null,
    sb: Sandbox,
  ): void {
    if (serviceId) {
      const store = this.stores.getServicesStore();
      if (!store) return;
      try {
        store.patch(sessionId, serviceId, {
          status: 'running',
          last_access_at_ms: sb.lastAccessAt,
          paused_at_ms: null,
        });
      } catch (e) {
        console.warn(
          `[sandbox-manager] persist runtime pause ${sessionId}:${serviceId} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }
    this.persist(sb, 'running');
  }
}
