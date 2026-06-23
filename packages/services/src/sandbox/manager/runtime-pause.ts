/**
 * Runtime pause / unpause for sandbox containers — `podman pause` /
 * `podman unpause` semantics (NOT `podman stop`). The process tree and
 * port bindings stay in place; the OCI runtime freezes the cgroup.
 *
 * Distinct from `pauseSandbox` / `resumeSandbox` which do `stop` + tar
 * archive — that path lives in the manager body until its dependencies
 * (archive store, dev-server relaunch) are decoupled.
 *
 * Extracted from `SandboxManager.pauseRuntimeContainer` /
 * `unpauseRuntimeContainer` / `runtimePauseTarget` so each method's
 * contract (idempotency, inspect-then-act, persist after) is testable
 * with a fake driver alone.
 */
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';

export interface RuntimePauseTarget {
  sb: Sandbox;
  /** `null` for the primary sandbox, `serviceId` for a secondary service. */
  serviceId: string | null;
}

/**
 * Resolve the sandbox a pause/unpause/refresh request points at. Throws
 * when the sandbox is missing so callers get a clean 404-ish surface
 * without re-implementing the check.
 */
export function resolveRuntimePauseTarget(
  registry: SandboxRegistry,
  sessionId: string,
  serviceId?: string | null,
): RuntimePauseTarget {
  if (!serviceId || serviceId === 'main') {
    const sb = registry.getPrimary(sessionId);
    if (!sb) throw new Error(`No sandbox for session ${sessionId}`);
    return { sb, serviceId: null };
  }
  const sb = registry.getService(sessionId, serviceId);
  if (!sb) throw new Error(`No service '${serviceId}' for session ${sessionId}`);
  return { sb, serviceId };
}

export interface RuntimePauseDeps {
  /** Append a line to the sandbox's recent-logs ring buffer. */
  appendLog: (sb: Sandbox, level: 'info' | 'error', text: string) => void;
  /**
   * Persist the new `runtimePaused` flag + `last_access_at_ms` so a
   * server restart sees the freeze state correctly. Caller is the
   * manager (passes `persistRuntimePauseState`); tests can pass a no-op.
   */
  persistRuntimePauseState: (
    sessionId: string,
    serviceId: string | null,
    sb: Sandbox,
  ) => void;
}

/**
 * Idempotent: returns immediately when the sandbox already has
 * `runtimePaused === true`. Refuses to pause non-ready sandboxes
 * (provisioning / error) since freezing them mid-transition would
 * leave the manager out of sync with the runtime.
 *
 * Reconciles with the live runtime via `inspectContainer` so a
 * container that was paused/destroyed outside the manager surfaces a
 * clear error to the caller instead of a silent success.
 */
export async function runtimePauseContainer(
  sessionId: string,
  resolvedServiceId: string | null,
  sb: Sandbox,
  driver: ISandboxDriver,
  deps: RuntimePauseDeps,
): Promise<Sandbox> {
  if (sb.runtimePaused) return sb;
  if (sb.status !== 'ready') {
    throw new Error(`Cannot runtime-pause ${sb.id} from status '${sb.status}'`);
  }
  if (!sb.containerId) throw new Error(`No container id for ${sb.id}`);

  const inspect = await driver.inspectContainer(sb.containerId);
  if (!inspect.exists) throw new Error(`Container for ${sb.id} no longer exists`);
  if (inspect.paused) {
    sb.runtimePaused = true;
  } else {
    if (!inspect.running) throw new Error(`Container for ${sb.id} is not running`);
    deps.appendLog(sb, 'info', 'Runtime pause requested.');
    await driver.pauseContainer(sb.containerId);
    sb.runtimePaused = true;
  }
  sb.lastAccessAt = Date.now();
  deps.persistRuntimePauseState(sessionId, resolvedServiceId, sb);
  return sb;
}

/**
 * Idempotent: when both `inspect.paused` and `sb.runtimePaused` are
 * false but the container is still running, this is a no-op success.
 * Otherwise calls `unpauseContainer` even if only one of the two flags
 * indicates the container is frozen — a previous crash may have left
 * them out of sync.
 */
export async function runtimeUnpauseContainer(
  sessionId: string,
  resolvedServiceId: string | null,
  sb: Sandbox,
  driver: ISandboxDriver,
  deps: RuntimePauseDeps,
): Promise<Sandbox> {
  if (!sb.containerId) throw new Error(`No container id for ${sb.id}`);

  const inspect = await driver.inspectContainer(sb.containerId);
  if (!inspect.exists) throw new Error(`Container for ${sb.id} no longer exists`);
  if (inspect.paused || sb.runtimePaused) {
    deps.appendLog(sb, 'info', 'Runtime unpause requested.');
    await driver.unpauseContainer(sb.containerId);
  } else if (!inspect.running) {
    throw new Error(`Container for ${sb.id} is not running`);
  }
  sb.runtimePaused = false;
  if (sb.status === 'ready') sb.step = 'ready';
  sb.lastAccessAt = Date.now();
  deps.persistRuntimePauseState(sessionId, resolvedServiceId, sb);
  return sb;
}
