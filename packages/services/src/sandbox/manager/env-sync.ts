/**
 * Push the session's resolved env vars into every owned container as a
 * `.env` file. Used after `env_set` / `env_delete` so running dev
 * servers pick up the new values on their next file-watch tick.
 *
 * Extracted from `SandboxManager.syncEnvsToAllContainers` so the
 * env-propagation contract is documented and unit-testable independent
 * of the manager's larger orchestration surface:
 *   1. External-mount services SKIP — the user owns that `.env`.
 *   2. Runtime-paused services SKIP — write would block on the OCI freeze.
 *   3. Without a driver wired, the call is a clean no-op.
 *   4. Without any targets, the call is a clean no-op.
 *   5. Writes go out via `Promise.allSettled` so one bad container
 *      doesn't block the rest.
 *   6. D1 scope enforcement: each target gets ITS OWN body rendered for
 *      its `serviceId` ('main' = primary) — vars scoped to other
 *      services never land in this container's `.env`.
 */
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';

export interface EnvSyncTarget {
  /** Service id used for scope filtering — `'main'` for the primary. */
  serviceId: string;
  containerId: string;
  workdir: string;
}

export interface EnvSyncReport {
  state: 'applied' | 'partial' | 'failed' | 'stored';
  applied: string[];
  failed: Array<{ serviceId: string; reason: string }>;
  restartRequired: boolean;
}

/**
 * Filter the sandboxes (primary + services) that the env body should be
 * written to. Pure function — easy to assert against.
 */
export function collectEnvSyncTargets(
  primary: Sandbox | undefined,
  services: ReadonlyArray<{ serviceId: string; sandbox: Sandbox }>,
): EnvSyncTarget[] {
  const targets: EnvSyncTarget[] = [];
  if (primary?.containerId && !primary.runtimePaused && primary.mountKind !== 'external') {
    targets.push({ serviceId: 'main', containerId: primary.containerId, workdir: primary.workdir });
  }
  for (const { serviceId, sandbox: svc } of services) {
    if (svc.containerId && !svc.runtimePaused && svc.mountKind !== 'external') {
      targets.push({ serviceId, containerId: svc.containerId, workdir: svc.workdir });
    }
  }
  return targets;
}

/**
 * Write a PER-SERVICE rendered `.env` body to every eligible container
 * under the session. `bodyFor` receives the target's service id so the
 * caller can enforce `service_scope` (D1). Returns silently when there
 * are no targets or no driver.
 */
export async function pushEnvsToContainers(
  targets: readonly EnvSyncTarget[],
  bodyFor: (serviceId: string) => string | Promise<string>,
  driver: ISandboxDriver | null,
): Promise<EnvSyncReport> {
  if (targets.length === 0 || !driver) return { state: 'stored', applied: [], failed: [], restartRequired: false };
  const results = await Promise.allSettled(
    targets.map(async (t) =>
      driver.writeFile(t.containerId, `${t.workdir}/.env`, await bodyFor(t.serviceId), {
        recursive: true,
      }),
    ),
  );
  const applied: string[] = [];
  const failed: EnvSyncReport['failed'] = [];
  results.forEach((result, index) => {
    const serviceId = targets[index]!.serviceId;
    if (result.status === 'fulfilled') applied.push(serviceId);
    // Driver errors may contain command/env content. Never expose their raw text.
    else failed.push({ serviceId, reason: 'environment_write_failed' });
  });
  return { state: failed.length ? (applied.length ? 'partial' : 'failed') : 'applied', applied, failed, restartRequired: applied.length > 0 };
}
