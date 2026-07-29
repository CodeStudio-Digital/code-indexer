/**
 * DB → runtime reconciliation. On server boot (and on each
 * session/service inspect call) we walk the persisted `company_sandboxes`
 * + `company_sandbox_services` rows and align the in-memory registry
 * with the runtime's actual state:
 *
 *   row status    runtime          → action
 *   ───────────── ──────────────── ──────────────────────────────
 *   running       running          reclaim (registry, status=ready)
 *   running       stopped          mark paused in DB; add to registry
 *   paused        stopped          reclaim (registry, status=paused)
 *   paused        running          rare — treat as running, update DB
 *   any           gone (pruned)    delete row (primary) / patch paused
 *                                  with hint (service)
 *
 * Extracted from `SandboxManager` (lines 2064-2293 of the original
 * monolith) so the runtime-vs-DB drift logic is unit-testable with a
 * fake driver + in-memory store, independent of provision/destroy paths.
 *
 * The class methods that used to live inline now delegate here via a
 * deps bag — same pattern as `attached.ts` / `runtime-pause.ts` etc.
 */
import type {
  Sandbox,
  SandboxStatus,
} from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';
import type {
  CompanySandboxStore,
  PersistedSandboxRow,
  PersistedSandboxStatus,
} from '@mcp/store/company-sandbox-store.js';
import type {
  CompanySandboxServicesStore,
  PersistedSandboxServiceRow,
} from '@mcp/store/company-sandbox-services-store.js';
import {
  buildPrimarySandboxFromRow,
  buildServiceSandboxFromRow,
  buildAttachedServiceSandboxFromRow,
} from '@mcp/services/sandbox/manager/persistence/sandbox-from-row.js';
import { resolveAttachedState } from '@mcp/services/sandbox/manager/attached.js';

export interface ReconcileResult {
  sandbox: Sandbox | null;
  missing: boolean;
  /** Only meaningful for services — true when the row is reclaimed but currently paused. */
  stopped: boolean;
}

export interface ReconcileDeps {
  registry: SandboxRegistry;
  store: CompanySandboxStore | null;
  servicesStore: CompanySandboxServicesStore | null;
  /** Add a port to the allocator's in-use set without re-running its bind probe. */
  reservePort: (port: number) => Promise<void>;
  /** Release a port back to the allocator (used on the "container gone" branch). */
  releasePort: (port: number) => void;
  /**
   * Options handed to `buildPrimarySandboxFromRow`. Captures the
   * manager's `devServerPort` + `buildPreviewUrl` so the reconcile path
   * doesn't need the whole manager instance.
   */
  buildPrimaryOpts: {
    devServerPort: number;
    buildPreviewUrl: (sessionId: string, hostPort: number) => string;
  };
  buildServiceOpts: { devServerPort: number };
  toPersistedStatus: (status: SandboxStatus) => PersistedSandboxStatus;
}

// ─── Primary sandbox reconciliation ─────────────────────────────

/**
 * Inspect the runtime for `row.container_id`, reconcile the registry
 * + DB row, return a `ReconcileResult`. The decision matrix is the one
 * documented at the top of the file.
 */
export async function reconcilePrimaryRowFromDb(
  driver: ISandboxDriver,
  row: PersistedSandboxRow,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const inspect = await driver.inspectContainer(row.container_id);
  if (!inspect.exists) {
    // Container is gone (pruned, VM reset). Clear the DB row so
    // the next provision falls through to archive-restore.
    deps.store?.delete(row.session_id);
    deps.releasePort(row.host_port);
    return { sandbox: null, missing: true, stopped: false };
  }

  await deps.reservePort(row.host_port);

  const effectiveStatus: SandboxStatus = inspect.running
    ? 'ready'
    : inspect.paused
      ? 'ready'
      : row.status === 'paused'
        ? 'paused'
        : 'paused'; // running-in-DB but stopped-in-runtime -> now paused

  const sb = buildPrimarySandboxFromRow(row, effectiveStatus, inspect.paused, deps.buildPrimaryOpts);
  deps.registry.primary.set(sb.id, sb);

  if (effectiveStatus === 'paused' && row.status !== 'paused') {
    deps.store?.patch(row.session_id, { status: 'paused', paused_at_ms: Date.now() });
  } else if (effectiveStatus === 'ready' && row.status === 'paused') {
    deps.store?.patch(row.session_id, { status: 'running', paused_at_ms: null });
  }
  return { sandbox: sb, missing: false, stopped: false };
}

/** Look up the active primary row for `sessionId` and reconcile it. */
export async function reconcilePrimaryForSession(
  driver: ISandboxDriver,
  sessionId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult | null> {
  if (!deps.store) return null;
  const row = deps.store.get(sessionId);
  if (!row || row.status === 'destroyed') return null;
  return reconcilePrimaryRowFromDb(driver, row, deps);
}

// ─── Secondary service reconciliation ───────────────────────────

export async function reconcileServiceRowFromDb(
  driver: ISandboxDriver,
  row: PersistedSandboxServiceRow,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  if (row.is_attached === 1 && row.external_container_ref) {
    // Attached rows: pure inspect, no port reservation, never offer
    // "Press Play to recreate" — the user owns the container.
    const state = await resolveAttachedState(driver, row.external_container_ref);
    const sb = buildAttachedServiceSandboxFromRow(row, state);
    deps.registry.setService(String(row.session_id), row.service_id, sb);
    deps.servicesStore?.patch(row.session_id, row.service_id, {
      status: deps.toPersistedStatus(sb.status),
      error: sb.error ?? null,
      last_access_at_ms: sb.lastAccessAt,
      paused_at_ms: sb.status === 'paused' ? Date.now() : null,
    });
    return { sandbox: sb, missing: !state.exists, stopped: state.status !== 'ready' };
  }
  const inspect = await driver.inspectContainer(row.container_id);
  if (!inspect.exists) {
    // Container is gone (image rebuilt, docker prune, host reset).
    // Keep the durable service row, but do NOT re-provision it on
    // boot/open. Manual-first lifecycle: the UI surfaces this as
    // paused/recoverable and the user decides when to press Play.
    deps.releasePort(row.host_port);
    deps.servicesStore?.patch(row.session_id, row.service_id, {
      status: 'paused',
      error: 'Container is not present. Press Play to recreate it from the saved project files.',
      paused_at_ms: Date.now(),
    });
    return { sandbox: null, missing: true, stopped: false };
  }
  await deps.reservePort(row.host_port);

  const effectiveStatus: SandboxStatus =
    inspect.running || inspect.paused ? 'ready' : 'paused';
  const sb = buildServiceSandboxFromRow(row, effectiveStatus, inspect.paused, deps.buildServiceOpts);
  deps.registry.setService(String(row.session_id), row.service_id, sb);

  if (effectiveStatus === 'paused') {
    deps.servicesStore?.patch(row.session_id, row.service_id, {
      status: 'paused',
      paused_at_ms: Date.now(),
      error: null,
    });
  } else if (row.status !== 'running') {
    deps.servicesStore?.patch(row.session_id, row.service_id, {
      status: 'running',
      paused_at_ms: null,
      error: null,
    });
  }
  return { sandbox: sb, missing: false, stopped: effectiveStatus === 'paused' };
}

export async function reconcileServicesForSession(
  driver: ISandboxDriver,
  sessionId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult[]> {
  if (!deps.servicesStore) return [];
  const results: ReconcileResult[] = [];
  for (const row of deps.servicesStore.listBySession(sessionId)) {
    if (row.status === 'destroyed') continue;
    results.push(await reconcileServiceRowFromDb(driver, row, deps));
  }
  return results;
}

export async function reconcileServiceForSession(
  driver: ISandboxDriver,
  sessionId: string,
  serviceId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult | null> {
  if (!deps.servicesStore) return null;
  const row = deps.servicesStore.get(sessionId, serviceId);
  if (!row || row.status === 'destroyed') return null;
  return reconcileServiceRowFromDb(driver, row, deps);
}

// ─── Boot-time full reconciliation ──────────────────────────────

export async function reconcileAllPrimaryFromDb(
  driver: ISandboxDriver,
  deps: ReconcileDeps,
): Promise<void> {
  const rows = deps.store?.listActive() ?? [];
  let reclaimed = 0;
  let lost = 0;
  for (const row of rows) {
    try {
      const result = await reconcilePrimaryRowFromDb(driver, row, deps);
      if (result.missing) lost++;
      else if (result.sandbox) reclaimed++;
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
}

export async function reconcileAllServicesFromDb(
  driver: ISandboxDriver,
  deps: ReconcileDeps,
): Promise<void> {
  if (!deps.servicesStore) return;
  const rows = deps.servicesStore.listActive();
  if (rows.length === 0) return;

  let reclaimed = 0;
  let stopped = 0;
  let orphan = 0;
  for (const row of rows) {
    try {
      const result = await reconcileServiceRowFromDb(driver, row, deps);
      if (result.missing) {
        orphan++;
        continue;
      }
      if (result.stopped) stopped++;
      if (result.sandbox) reclaimed++;
    } catch (e) {
      console.warn(
        `[sandbox-manager] reconcile service=${row.session_id}:${row.service_id} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (reclaimed > 0 || stopped > 0 || orphan > 0) {
    console.log(
      `[sandbox-manager] reconciled services from DB: ${reclaimed} reclaimed, ${stopped} stopped, ${orphan} missing (manual start required)`,
    );
  }
}
