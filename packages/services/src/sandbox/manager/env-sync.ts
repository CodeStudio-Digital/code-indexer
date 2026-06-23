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
 */
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { ISandboxDriver } from '@mcp/services/sandbox/ports/sandbox-driver.js';

export interface EnvSyncTarget {
  containerId: string;
  workdir: string;
}

/**
 * Filter the sandboxes (primary + services) that the env body should be
 * written to. Pure function — easy to assert against.
 */
export function collectEnvSyncTargets(
  primary: Sandbox | undefined,
  services: readonly Sandbox[],
): EnvSyncTarget[] {
  const targets: EnvSyncTarget[] = [];
  if (primary?.containerId && !primary.runtimePaused && primary.mountKind !== 'external') {
    targets.push({ containerId: primary.containerId, workdir: primary.workdir });
  }
  for (const svc of services) {
    if (svc.containerId && !svc.runtimePaused && svc.mountKind !== 'external') {
      targets.push({ containerId: svc.containerId, workdir: svc.workdir });
    }
  }
  return targets;
}

/**
 * Write the rendered `.env` body to every eligible container under the
 * session. Returns silently when there are no targets or no driver.
 */
export async function pushEnvsToContainers(
  targets: readonly EnvSyncTarget[],
  body: string,
  driver: ISandboxDriver | null,
): Promise<void> {
  if (targets.length === 0 || !driver) return;
  await Promise.allSettled(
    targets.map((t) =>
      driver.writeFile(t.containerId, `${t.workdir}/.env`, body, { recursive: true }),
    ),
  );
}
