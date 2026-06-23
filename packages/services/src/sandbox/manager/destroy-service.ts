/**
 * Service-container teardown — `destroyService` body lifted out of
 * `SandboxManager` so the surprisingly long side-effect chain is
 * documented in one place and the persistence/event semantics can be
 * tested with a fake driver alone.
 *
 * Steps (in order):
 *   1. Resolve the service from the registry; bail if it never existed.
 *   2. Flip status to 'destroying' + emit `destroying` event.
 *   3. Call `driver.destroy` ONLY for owned containers. Attached
 *      services reference user-managed containers; we never destroy
 *      those — only drop the binding.
 *   4. Release the host port back to the allocator.
 *   5. Delete the in-memory registry entry, flip status to 'destroyed'.
 *   6. Persist: HARD delete for user-driven removes, soft `status='destroyed'`
 *      tombstone for transient teardowns (retry / abort / reaper / TTL).
 *      Tombstones let the UI surface orphaned project links + offer Retry.
 *   7. Emit `destroyed` event.
 *   8. Re-sync managed `PREVIEW_URL_*` / `SERVICE_URL_*` env vars (the
 *      removed service's keys must disappear from the survivors).
 *   9. If this was the last container for the session (no primary, no
 *      services), drop the shared docker network — leaks otherwise.
 */
import type { Sandbox, SandboxEvent } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';
import type { CompanySandboxServicesStore } from '@mcp/store/company-sandbox-services-store.js';

/**
 * True only for explicit user-driven removals. All other teardown
 * reasons (retry, abort, session-end, TTL reaper) are transient — the
 * project link in `company_session_projects` outlives the container,
 * so wiping the row would leave an orphaned project nobody can see
 * or recover from the UI.
 */
export function shouldHardDeleteService(reason: string): boolean {
  return reason === 'user-removed' || reason === 'user-removed-offline';
}

export interface DestroyServiceDeps {
  driver: ISandboxDriver | null;
  registry: SandboxRegistry;
  allocator: { release(port: number): void };
  servicesStore: CompanySandboxServicesStore | null;
  emit: (event: SandboxEvent) => void;
  syncManagedEnvs: (sessionId: string) => void;
  syncEnvsToAllContainers: (sessionId: string) => Promise<void>;
  destroySessionNetwork: (sessionId: string) => Promise<void>;
}

export async function executeServiceDestroy(
  sessionId: string,
  serviceId: string,
  reason: string,
  deps: DestroyServiceDeps,
): Promise<void> {
  const sb = deps.registry.getService(sessionId, serviceId);
  if (!sb) return;
  sb.status = 'destroying';
  deps.emit({ kind: 'destroying', sandboxId: sb.id, reason });
  try {
    if (sb.containerId && deps.driver && !sb.attached) {
      await deps.driver.destroy(sb.containerId);
    }
  } catch (e) {
    console.warn(
      `[sandbox-manager] destroy service ${sessionId}:${serviceId} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    deps.allocator.release(sb.hostPort);
    deps.registry.deleteService(sessionId, serviceId);
    sb.status = 'destroyed';
    persistAfterDestroy(deps.servicesStore, sessionId, serviceId, sb, reason);
    deps.emit({ kind: 'destroyed', sandboxId: sb.id });

    // Prune the managed PREVIEW_URL_* env for the removed service
    // and push fresh .env into the survivors.
    deps.syncManagedEnvs(sessionId);
    void deps.syncEnvsToAllContainers(sessionId).catch(() => void 0);

    // When the session has no more additional services AND the primary
    // is gone too, drop the shared network. When the primary is still
    // up we leave the network alive so future additions are cheap.
    if (
      deps.registry.listServicesForSession(sessionId).length === 0 &&
      !deps.registry.hasPrimary(sessionId)
    ) {
      await deps.destroySessionNetwork(sessionId);
    }
  }
}

function persistAfterDestroy(
  servicesStore: CompanySandboxServicesStore | null,
  sessionId: string,
  serviceId: string,
  sb: Sandbox,
  reason: string,
): void {
  const numericId = Number(sessionId);
  if (!servicesStore || !Number.isFinite(numericId)) return;
  try {
    if (shouldHardDeleteService(reason)) {
      servicesStore.delete(numericId, serviceId);
    } else {
      servicesStore.patch(numericId, serviceId, {
        status: 'destroyed',
        error: `destroyed (${reason})`,
        container_id: sb.containerId,
      });
    }
  } catch { /* logged elsewhere */ }
}
