import { orchestratorRegistry } from '@apps/http-api/sse/OrchestratorRegistry.js';
import type { SandboxBinding } from '@mcp/company/types.js';
import type { SandboxService } from '../services/SandboxService.js';

export interface SandboxPeer {
  serviceId: string;
  stack: string;
  internalUrl: string;
  previewUrl: string;
  isSelf: boolean;
}

/**
 * Resolve the primary sandbox binding for a session. Sub-sessions defer to
 * the parent's binding so all sibling tabs edit the same container/workdir.
 */
export function getSandboxBinding(
  sandboxService: SandboxService,
  parentSessionId: number | null,
): SandboxBinding | null {
  const own = sandboxService.getBinding();
  if (own) return own;
  if (parentSessionId != null) {
    return orchestratorRegistry.get(parentSessionId)?.getSandboxBinding() ?? null;
  }
  return null;
}

/**
 * Resolve a secondary-service binding for `serviceId`. Subordinates working
 * on a microservice project MUST use this instead of `getSandboxBinding` —
 * otherwise their tool writes land in the master's workdir rather than the
 * service's own bind-mounted host dir.
 */
export function getSandboxServiceBinding(
  sandboxService: SandboxService,
  parentSessionId: number | null,
  serviceId: string,
): SandboxBinding | null {
  const own = sandboxService.getServiceBinding(serviceId);
  if (own) return own;
  if (parentSessionId != null) {
    return orchestratorRegistry.get(parentSessionId)?.getSandboxServiceBinding(serviceId) ?? null;
  }
  return null;
}

/**
 * Snapshot of all sandbox containers alive on this session (primary +
 * secondaries) annotated with the `internalUrl` siblings use to reach each
 * other on the shared docker network. Sub-sessions defer to the parent.
 *
 * The internal port matches the dev-server convention (5173 by default;
 * MCP_SANDBOX_DEV_PORT overrides). Hostname is the service_id — `main` for
 * the primary legacy/multi service.
 */
export function listSandboxPeers(
  sandboxService: SandboxService,
  parentSessionId: number | null,
  selfServiceId?: string | null,
): SandboxPeer[] {
  if (parentSessionId != null) {
    const parent = orchestratorRegistry.get(parentSessionId);
    if (parent) return parent.listSandboxPeers(selfServiceId);
    return [];
  }

  const devPort = Number(process.env.MCP_SANDBOX_DEV_PORT ?? 5173);
  const peers: SandboxPeer[] = [];

  const primary = sandboxService.getBinding();
  if (primary) {
    const id = primary.serviceId ?? 'main';
    peers.push({
      serviceId: id,
      stack: sandboxService.getStackForService(null) ?? 'unknown',
      internalUrl: `http://${id}:${devPort}`,
      previewUrl: primary.previewUrl,
      isSelf: (selfServiceId ?? 'main') === id,
    });
  }
  for (const { serviceId, binding } of sandboxService.listServiceBindings()) {
    peers.push({
      serviceId,
      stack: sandboxService.getStackForService(serviceId) ?? 'unknown',
      internalUrl: `http://${serviceId}:${devPort}`,
      previewUrl: binding.previewUrl,
      isSelf: (selfServiceId ?? null) === serviceId,
    });
  }
  return peers;
}

/**
 * Provision the sandbox on demand. Sub-sessions never spin their own
 * container — they share the parent's. Without this every new tab would
 * start a duplicate container against the same bind-mount, wasting
 * resources and racing on file writes.
 */
export async function provisionSandboxIfNeeded(
  sandboxService: SandboxService,
  parentSessionId: number | null,
  signal?: AbortSignal,
): Promise<SandboxBinding | null> {
  if (parentSessionId != null) {
    const parent = orchestratorRegistry.get(parentSessionId);
    if (!parent) return null;
    return await parent.provisionSandboxIfNeeded(signal);
  }
  return await sandboxService.provisionIfNeeded({ signal });
}
