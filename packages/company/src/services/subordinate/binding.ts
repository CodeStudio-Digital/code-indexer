/**
 * Resolve the `SandboxBinding` a subordinate should run inside for a
 * given project id. Logic:
 *
 *   1. If the project is labeled (microservice), look up the service-
 *      specific binding first — that's the container the user labeled
 *      this project against in the sidebar.
 *   2. Fall back to the PRIMARY container ONLY when its `hostWorkdirMount`
 *      matches the project's `root_path` (path-normalised). Otherwise
 *      return `null` — a stale primary binding would route the
 *      subordinate to the wrong workdir.
 *
 * Extracted from `SubordinateLifecycle.resolveBindingForProject` so
 * both `spawn` and `resume` can share the lookup without re-implementing
 * the priority / fallback logic.
 *
 * Path normalisation lives here too because Windows / POSIX path
 * comparisons drift across hosts: `/c/Users/...` vs `C:\Users\...`.
 */
import { normalize as nodeNormalize, sep } from 'node:path';
import type { SandboxBinding } from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';

interface BindingOrchestrator {
  getSandboxBinding?: () => SandboxBinding | null;
  getSandboxServiceBinding?: (serviceId: string) => SandboxBinding | null;
}

/**
 * Normalise a host path for case/separator-insensitive comparison. On
 * Windows we lowercase + forward-slashify so `C:\Users\foo` and
 * `c:/users/foo` resolve equal. On POSIX we just normalise.
 */
export function normalizeHostPath(p: string): string {
  if (!p) return p;
  const normalised = nodeNormalize(p);
  if (sep === '\\') {
    return normalised.replace(/\\/g, '/').toLowerCase();
  }
  return normalised;
}

export function resolveBindingForProject(
  ctx: SessionContext,
  orchestratorRef: unknown,
  projectId: number,
): SandboxBinding | null {
  const orchestrator = orchestratorRef as BindingOrchestrator;
  const project = ctx.projects.find((p) => p.project_id === projectId);
  const label = project?.label ?? null;
  if (label && orchestrator.getSandboxServiceBinding) {
    const svc = orchestrator.getSandboxServiceBinding(label);
    if (svc) return svc;
  }
  const primary = orchestrator.getSandboxBinding ? orchestrator.getSandboxBinding() : null;
  if (!primary) return null;
  const projectRoot = ctx.db.getProject(projectId)?.root_path ?? null;
  if (
    projectRoot &&
    primary.hostWorkdirMount &&
    normalizeHostPath(projectRoot) === normalizeHostPath(primary.hostWorkdirMount)
  ) {
    return primary;
  }
  return null;
}
