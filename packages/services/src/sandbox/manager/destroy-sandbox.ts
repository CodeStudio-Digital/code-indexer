/**
 * Tear down the PRIMARY sandbox of a session. Distinct from
 * `destroyService` (which handles secondary services in
 * `destroy-service.ts`) — the primary lives in `company_sandboxes`,
 * not `company_sandbox_services`, and follows a different persistence
 * contract (hard delete of the row, no tombstone).
 *
 * Steps:
 *   1. Resolve the in-memory entry; bail when missing.
 *   2. Pre-destroy archive (fail-closed): tar the workdir out so the
 *      next provision can `restoreArchive` it. Skipped for bind-mount
 *      sandboxes (workdir already on host) and the 'session-deleted'
 *      reason (the complete session bundle is about to move to trash).
 *   3. `driver.destroy(containerId)`. Failure logged, not rethrown —
 *      we still want to release local state.
 *   4. `allocator.release` + remove from registry + flip status to
 *      'destroyed'.
 *   5. Hard delete the persisted row (working-set cache, not audit).
 *   6. Emit `destroyed` event.
 */
import { saveArchive } from '@mcp/services/sandbox/archive.js';
import type { Sandbox, SandboxEvent } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';
import type { CompanySandboxStore } from '@mcp/store/company-sandbox-store.js';

export interface DestroySandboxDeps {
  driver: ISandboxDriver | null;
  registry: SandboxRegistry;
  allocator: { release(port: number): void };
  store: CompanySandboxStore | null;
  emit: (event: SandboxEvent) => void;
}

export async function destroySandboxInternal(
  sessionId: string,
  reason: string,
  deps: DestroySandboxDeps,
): Promise<void> {
  const sb = deps.registry.getPrimary(sessionId);
  if (!sb) return;
  const previousStatus = sb.status;
  sb.status = 'destroying';
  deps.emit({ kind: 'destroying', sandboxId: sessionId, reason });

  // Persist the workdir BEFORE destroying. Applied to every destroy
  // path uniformly — TTL eviction, orchestrator teardown, server-side
  // abort, the 'session-deleted' reason from DELETE /sessions. The
  // DELETE path is the one exception we DON'T want to archive for because
  // the complete bundle, including any existing archive, moves to trash.
  //
  // Bind-mounted sandboxes already persist on the host — archiving
  // would duplicate data and stale out on the next edit.
  const shouldArchive =
    reason !== 'session-deleted' &&
    !sb.hostWorkdirMount &&
    sb.containerId &&
    deps.driver;
  if (shouldArchive && sb.containerId && deps.driver) {
    try {
      const tar = await deps.driver.exportWorkdir(sb.containerId, sb.workdir);
      if (!tar || tar.byteLength === 0) {
        throw new Error('sandbox driver returned an empty workdir archive');
      }
      await saveArchive(sessionId, tar);
    } catch (e) {
      // Keep the live container and its registry entry intact. Destroying it
      // after an authority/write failure would turn a recoverable storage
      // outage into data loss.
      sb.status = previousStatus;
      const message =
        `Destroy refused because the session archive could not be committed: ${
          e instanceof Error ? e.message : String(e)
        }`;
      sb.error = message;
      deps.emit({ kind: 'error', sandboxId: sessionId, message });
      throw new Error(
        `[sandbox-manager] pre-destroy archive ${sessionId} failed closed: ${
          e instanceof Error ? e.message : String(e)
        }`,
        { cause: e },
      );
    }
  }

  try {
    if (sb.containerId && deps.driver) {
      await deps.driver.destroy(sb.containerId);
    }
  } catch (e) {
    // Logged, not rethrown: we still want to free local state.
    console.warn(
      `[sandbox-manager] destroy ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    deps.allocator.release(sb.hostPort);
    deps.registry.primary.delete(sessionId);
    sb.status = 'destroyed';
    if (deps.store) {
      try {
        deps.store.delete(sessionId);
      } catch (e) {
        console.warn(
          `[sandbox-manager] trash sandbox record for ${sessionId} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    deps.emit({ kind: 'destroyed', sandboxId: sessionId });
  }
}

export interface DestroyAllDeps {
  /** Snapshot of primary session ids — caller owns the order/timing of capture. */
  primaryIds: () => string[];
  /** Snapshot of `${sessionId}:${serviceId}` keys. */
  serviceKeys: () => string[];
  destroyService: (sessionId: string, serviceId: string, reason: string) => Promise<void>;
  destroyPrimary: (sessionId: string, reason: string) => Promise<void>;
  stopReaper: () => void;
  setShuttingDown: (value: boolean) => void;
}

/**
 * Tear down EVERY sandbox + service this manager owns. Services first
 * (their destroy path attempts to drop the shared docker network and
 * we want that to complete before we tear the primary containers that
 * also sit on it). Both passes use `Promise.allSettled` so one rogue
 * container doesn't block the rest.
 */
export async function destroyAllSandboxes(
  reason: string,
  deps: DestroyAllDeps,
): Promise<void> {
  deps.setShuttingDown(true);
  deps.stopReaper();
  const ids = deps.primaryIds();
  const serviceKeys = deps.serviceKeys();
  await Promise.allSettled(
    serviceKeys.map((key) => {
      const [sid, svcId] = key.split(':');
      return deps.destroyService(sid!, svcId!, reason);
    }),
  );
  await Promise.allSettled(ids.map((id) => deps.destroyPrimary(id, reason)));
}
