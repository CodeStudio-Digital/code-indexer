/**
 * Deps-bound helpers shared between the company sandbox + services routes
 * and the session CRUD route that still calls `removeServiceAndProject`
 * via the DELETE /projects/:projectId path.
 *
 * Phase 8 part 2 (continuation): extracted from `sessions.ts` so the
 * services + sandbox split files can reuse `startPrimarySandboxForSession`
 * and `removeServiceAndProject` without re-importing the whole sessions
 * route module.
 *
 * Pure helpers (isBuilderStack/validateLimits/etc.) live in
 * `sandbox-helpers.ts`. These belong here because they touch
 * `companyStore`, `db`, `companySandboxServicesStore`, the orchestrator
 * registry, and the singleton sandbox manager.
 */
import { rm } from 'node:fs/promises';
import type { ServerDeps } from '../../deps.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import type {
  Sandbox,
  BuilderStack,
  ProvisionableStack,
} from '@mcp/services/sandbox/types.js';
import { orchestratorRegistry } from '../../../sse/OrchestratorRegistry.js';
import {
  isProvisionableStack,
  resolveExternalProjectSpec,
  type ExternalProjectRuntime,
} from './sandbox-helpers.js';

/**
 * Provision (or retry) the primary sandbox of a session that was created
 * in builder mode. Returns a discriminated result the caller maps to an
 * HTTP response — the helper never throws on the happy path.
 */
export async function startPrimarySandboxForSession(
  deps: ServerDeps,
  id: number,
  retry = false,
): Promise<
  | { ok: true; sandbox: Sandbox }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string }
> {
  const { companyStore, db } = deps;
  const session = companyStore.getCompanySession(id);
  if (!session) return { ok: false, status: 404, error: 'session not found' };

  let stack: ProvisionableStack | null = null;
  let limits: { memory?: string; cpus?: string; pids?: number } | undefined;
  let cfg: {
    builder?: {
      stack?: string;
      limits?: { memory?: string; cpus?: string; pids?: number };
      main_project_id?: number;
      main_project_runtime?: ExternalProjectRuntime;
    };
  } = {};
  try {
    cfg = JSON.parse(session.config_json || '{}') as typeof cfg;
    if (isProvisionableStack(cfg.builder?.stack)) stack = cfg.builder.stack;
    if (cfg.builder?.limits) limits = cfg.builder.limits;
  } catch {
    /* treat as non-builder */
  }
  if (!stack) {
    return { ok: false, status: 409, error: 'session was not created with builder mode' };
  }

  const mainProjectId = cfg.builder?.main_project_id;
  const linkedProjects = companyStore.listCompanySessionProjects(id);
  const primaryLink =
    mainProjectId != null
      ? linkedProjects.find((p) => p.project_id === mainProjectId)
      : linkedProjects.find((p) => !p.label) ?? linkedProjects[0];
  const primaryProject = primaryLink ? db.getProject(primaryLink.project_id) : null;
  const hostWorkdirMount = primaryProject?.root_path ?? undefined;
  let externalSpec:
    | ReturnType<typeof resolveExternalProjectSpec>
    | {};
  if (mainProjectId != null) {
    if (!primaryProject) {
      return { ok: false, status: 404, error: `Project ${mainProjectId} not found` };
    }
    try {
      externalSpec = resolveExternalProjectSpec(
        primaryProject.root_path,
        stack as BuilderStack,
        cfg.builder?.main_project_runtime,
      );
    } catch (e) {
      return {
        ok: false,
        status: 400,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  } else {
    externalSpec = {};
  }

  try {
    const sandbox = await getSandboxManager().provision({
      sessionId: String(id),
      stack,
      retry,
      limits,
      hostWorkdirMount,
      ...externalSpec,
    });
    return { ok: true, sandbox };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Shape the standard JSON payload for a service-start response. Used by
 * both the primary-sandbox start and the additional-service start paths
 * so the UI sees the same fields regardless of which container was just
 * brought up.
 */
export function serviceStartPayload(serviceId: string, sb: Sandbox) {
  return {
    ok: true,
    service_id: serviceId,
    status: sb.runtimePaused ? 'paused' : sb.status,
    runtime_paused: !!sb.runtimePaused,
    preview_url: sb.previewUrl,
    container_id: sb.containerId,
  };
}

/**
 * Tear down a microservice container + the virtual `_builder_*` project
 * row + the workdir on disk. Idempotent and forgiving: each step is
 * best-effort so a partial state (manager already destroyed, link
 * already gone, etc.) still gets the remaining work done.
 *
 * Called from:
 *   - DELETE /sessions/:id/services/:serviceId (services.ts)
 *   - DELETE /sessions/:id/projects/:projectId (sessions.ts, when the
 *     project link has a non-null `label` — i.e. it points at a
 *     microservice rather than a real linked project).
 */
export async function removeServiceAndProject(
  deps: ServerDeps,
  id: number,
  serviceId: string,
): Promise<void> {
  const { companyStore, db } = deps;
  const linked = companyStore
    .listCompanySessionProjects(id)
    .find((p) => p.label === serviceId);
  const linkedProject = linked ? db.getProject(linked.project_id) : null;
  const serviceRow = deps.companySandboxServicesStore.get(id, serviceId);
  const isExternalProject =
    serviceRow?.mount_kind === 'external' ||
    (!!linkedProject && !linkedProject.name.startsWith('_builder_'));
  const isAttached = serviceRow?.is_attached === 1;

  if (isAttached) {
    // Attached services never had a podman container we own and never
    // had a `_builder_*` project row. Just drop the in-memory entry
    // (so list_containers/list_services stop reporting it) and the
    // persisted row. The user's container keeps running outside.
    await getSandboxManager()
      .destroyService(String(id), serviceId, 'user-removed')
      .catch(() => void 0);
    deps.companySandboxServicesStore.delete(id, serviceId);
    return;
  }

  const orch = orchestratorRegistry.get(id);
  if (orch) {
    await orch.sandboxService.removeService(serviceId);
  } else {
    await getSandboxManager()
      .destroyService(String(id), serviceId, 'user-removed-offline')
      .catch(() => void 0);
    deps.companySandboxServicesStore.delete(id, serviceId);
  }

  if (linkedProject) {
    try {
      companyStore.removeProjectFromCompanySession(id, linkedProject.id);
    } catch { /* best effort */ }
    if (isExternalProject) {
      return;
    }
    if (linkedProject.name.startsWith('_builder_') && linkedProject.root_path) {
      try {
        await rm(linkedProject.root_path, { recursive: true, force: true });
      } catch (e) {
        console.warn(
          `[sessions] failed to wipe service root_path ${linkedProject.root_path}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      try { db.deleteProject(linkedProject.id); } catch { /* best effort */ }
    }
  } else if (linked) {
    // Link existed but project row was already gone (orphan). Drop
    // the dangling link so it doesn't keep showing up as `project-<id>`.
    try {
      companyStore.removeProjectFromCompanySession(id, linked.project_id);
    } catch { /* best effort */ }
  }
}
