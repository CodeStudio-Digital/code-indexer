/**
 * Attached external services — user-managed containers (i.e. someone
 * ran `podman run` for them by hand) that we bind to a session as a
 * read-only viewpoint. The platform never starts/stops/destroys these
 * containers; we just inspect their state and let the session's agents
 * exec into them.
 *
 * Extracted from `SandboxManager`'s class body (originally lines
 * 1180-1421) so the attach lifecycle can be developed and tested
 * independently of the much larger primary-sandbox `provision()` path.
 *
 * The class methods that previously lived inline now delegate here.
 * Stateful concerns (the `services` Map, the persistence store, the
 * event bus) stay on the class — we just pass them in.
 */
import type {
  Sandbox,
  SandboxStatus,
} from '@mcp/services/sandbox/types.js';
import { DEFAULT_SANDBOX_LIMITS } from '@mcp/services/sandbox/types.js';
import type {
  ISandboxDriver,
} from '@mcp/services/sandbox/ports/sandbox-driver.js';
import type { CompanySandboxServicesStore } from '@mcp/store/company-sandbox-services-store.js';
import type { PersistedSandboxStatus } from '@mcp/store/company-sandbox-store.js';
import type { SandboxRegistry } from '@mcp/services/sandbox/manager/state/registry.js';

export interface AttachedState {
  exists: boolean;
  running: boolean;
  paused: boolean;
  status: SandboxStatus;
  error: string | null;
  runtimePaused: boolean;
}

/**
 * Inspect the runtime state of an externally-managed container and
 * normalise it to the manager's `Sandbox` status taxonomy. Pure modulo
 * the driver call — easy to fake.
 */
export async function resolveAttachedState(
  driver: ISandboxDriver,
  containerRef: string,
): Promise<AttachedState> {
  const inspect = await driver.inspectContainer(containerRef);
  if (!inspect.exists) {
    return {
      exists: false,
      running: false,
      paused: false,
      status: 'error',
      error: `Container '${containerRef}' not found.`,
      runtimePaused: false,
    };
  }
  if (inspect.paused) {
    return {
      exists: true,
      running: false,
      paused: true,
      status: 'ready',
      error: null,
      runtimePaused: true,
    };
  }
  if (inspect.running) {
    return {
      exists: true,
      running: true,
      paused: false,
      status: 'ready',
      error: null,
      runtimePaused: false,
    };
  }
  return {
    exists: true,
    running: false,
    paused: false,
    status: 'paused',
    error:
      'Container is not running. Start it from your host (`podman start`) and click Refresh.',
    runtimePaused: false,
  };
}

export interface AttachExternalServiceInput {
  sessionId: string;
  serviceId: string;
  containerRef: string;
  name?: string;
  hostname?: string;
}

export interface AttachExternalServiceDeps {
  driver: ISandboxDriver;
  servicesStore: CompanySandboxServicesStore | null;
  toPersistedStatus: (s: SandboxStatus) => PersistedSandboxStatus;
}

/**
 * Bind a pre-existing container to a session as a read-only service.
 * Validates the id (no `main`, lowercase + hyphen, ≤32 chars), probes
 * the container, builds the in-memory `Sandbox` entry, and persists a
 * row when a services store is wired. Returns the new entry — the
 * caller is responsible for inserting it into the manager's services
 * Map and emitting the `ready` event.
 */
export async function buildAttachedServiceSandbox(
  req: AttachExternalServiceInput,
  deps: AttachExternalServiceDeps,
): Promise<Sandbox> {
  if (req.serviceId === 'main') {
    throw new Error(`service_id 'main' is reserved for the primary sandbox`);
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(req.serviceId)) {
    throw new Error(
      `Invalid service_id '${req.serviceId}' — use lowercase letters, digits, hyphen; ≤32 chars`,
    );
  }
  const ref = req.containerRef.trim();
  if (!ref) throw new Error('container_ref is required');

  const state = await resolveAttachedState(deps.driver, ref);
  if (!state.exists) {
    throw new Error(state.error ?? `Container '${ref}' not found.`);
  }

  const hostname = (req.hostname ?? req.serviceId).trim() || req.serviceId;
  const serviceSandboxId = `${req.sessionId}:${req.serviceId}`;
  const sb: Sandbox = {
    id: serviceSandboxId,
    containerId: ref,
    runtime: deps.driver.runtime,
    stack: 'node-only',
    hostPort: 0,
    workdir: '/',
    containerPort: 0,
    previewUrl: '',
    limits: { ...DEFAULT_SANDBOX_LIMITS },
    status: state.status,
    runtimePaused: state.runtimePaused,
    step: state.status === 'ready' ? 'ready' : 'queued',
    recentLogs: [
      { at: Date.now(), level: 'info', text: `Attached external container ${ref}` },
    ],
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    mountKind: 'external',
    imageSource: 'default',
    error: state.error ?? undefined,
    attached: true,
    externalContainerRef: ref,
    attachedHostname: hostname,
  };

  if (deps.servicesStore) {
    try {
      deps.servicesStore.upsert({
        session_id: req.sessionId,
        service_id: req.serviceId,
        name: req.name ?? req.serviceId,
        container_id: ref,
        runtime: deps.driver.runtime,
        stack: 'attached',
        workdir: '/',
        host_workdir_mount: null,
        host_port: 0,
        limits: {},
        status: deps.toPersistedStatus(sb.status),
        error: sb.error ?? null,
        mount_kind: 'external',
        image_source: 'default',
        is_primary: false,
        last_access_at_ms: sb.lastAccessAt,
        paused_at_ms: null,
        is_attached: true,
        external_container_ref: ref,
        attached_hostname: hostname,
      });
    } catch (e) {
      console.warn(
        `[sandbox-manager] persist attached service ${req.sessionId}:${req.serviceId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return sb;
}

export interface RefreshAttachedServiceDeps {
  driver: import('@mcp/services/sandbox/ports/sandbox-driver.js').ISandboxDriver;
  registry: SandboxRegistry;
  servicesStore: CompanySandboxServicesStore | null;
  toPersistedStatus: (s: SandboxStatus) => PersistedSandboxStatus;
}

/**
 * Re-inspect an attached container and refresh both its in-memory entry
 * and the DB row. Used by `POST /services/:sid/refresh` so an operator
 * can re-sync state after starting/stopping the container outside the
 * platform. Throws when the row is not an attached service — callers
 * branch on `is_attached` before invoking.
 */
export async function refreshAttachedService(
  sessionId: string,
  serviceId: string,
  deps: RefreshAttachedServiceDeps,
): Promise<Sandbox> {
  const sb = deps.registry.getService(sessionId, serviceId);
  let ref = sb?.externalContainerRef ?? sb?.containerId ?? '';
  let hostname = sb?.attachedHostname ?? serviceId;
  if (!ref && deps.servicesStore) {
    const row = deps.servicesStore.get(sessionId, serviceId);
    if (row?.is_attached === 1 && row.external_container_ref) {
      ref = row.external_container_ref;
      hostname = row.attached_hostname || row.service_id;
    }
  }
  if (!ref) {
    throw new Error(`Service '${serviceId}' is not an attached external container.`);
  }

  const state = await resolveAttachedState(deps.driver, ref);

  let target = sb;
  if (!target) {
    target = {
      id: `${sessionId}:${serviceId}`,
      containerId: ref,
      runtime: deps.driver.runtime,
      stack: 'node-only',
      hostPort: 0,
      workdir: '/',
      containerPort: 0,
      previewUrl: '',
      limits: { ...DEFAULT_SANDBOX_LIMITS },
      status: state.status,
      runtimePaused: state.runtimePaused,
      step: state.status === 'ready' ? 'ready' : 'queued',
      recentLogs: [],
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
      mountKind: 'external',
      imageSource: 'default',
      attached: true,
      externalContainerRef: ref,
      attachedHostname: hostname,
      error: state.error ?? undefined,
    };
    deps.registry.setService(sessionId, serviceId, target);
  } else {
    target.status = state.status;
    target.runtimePaused = state.runtimePaused;
    target.error = state.error ?? undefined;
    target.lastAccessAt = Date.now();
    target.recentLogs.push({
      at: Date.now(),
      level: state.error ? 'error' : 'info',
      text:
        state.error ??
        `Refreshed: ${state.runtimePaused ? 'paused' : state.running ? 'running' : 'stopped'}`,
    });
    while (target.recentLogs.length > 200) target.recentLogs.shift();
  }

  if (deps.servicesStore) {
    try {
      deps.servicesStore.patch(sessionId, serviceId, {
        status: deps.toPersistedStatus(target.status),
        error: target.error ?? null,
        last_access_at_ms: target.lastAccessAt,
        paused_at_ms: target.status === 'paused' ? Date.now() : null,
      });
    } catch (e) {
      console.warn(
        `[sandbox-manager] refresh attached ${sessionId}:${serviceId} patch failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return target;
}
