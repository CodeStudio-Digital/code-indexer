import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { ProviderGatewayDependencies, ProviderGatewayLimits } from './ProviderGatewayTypes.js';
import type { ProviderOperationRegistry } from './ProviderOperationRegistry.js';
import { ProviderGatewayError } from './ProviderGatewayError.js';
import { validateProviderStart } from './ProviderGatewayValidation.js';
import { adaptProviderRequest } from './ProviderRequestAdapter.js';
import { raceAbort } from './ProviderAbort.js';
import { prepareGatewayContext } from './ProviderContextPreparation.js';

/** Uses the same bounded context and cancellation authority as provider start,
 * while persisting through the native writer without resolving credentials. */
export async function checkpointProviderFrontier(start: agentV1Runtime.ProviderStart, digest: Uint8Array,
  commit: (start: agentV1Runtime.ProviderStart, signal: AbortSignal) => Promise<void>,
  dependencies: ProviderGatewayDependencies, limits: ProviderGatewayLimits,
  registry: ProviderOperationRegistry, now: () => number): Promise<bigint> {
  const openedAt = now();
  validateProviderStart(start, digest, openedAt, limits);
  if (registry.size !== 0) throw new ProviderGatewayError('invalid_provider_request', 'checkpoint overlaps an active provider');
  const lease = registry.reserve(start.operationId, start.identity);
  const signal = lease.controller.signal;
  const timer = setTimeout(() => lease.controller.abort(new ProviderGatewayError(
    'provider_deadline_exceeded', 'checkpoint reached its deadline')), Number(start.deadlineAtUnixMs) - openedAt);
  try {
    start = await raceAbort(prepareGatewayContext(start, dependencies.contextPreparation, signal, true), signal);
    await raceAbort(adaptProviderRequest(start, dependencies.artifactReader, limits, signal), signal);
    await raceAbort(commit(start, signal), signal);
    signal.throwIfAborted();
    return BigInt(now());
  } finally { clearTimeout(timer); lease.release(); }
}
