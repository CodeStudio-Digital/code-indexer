import type { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import type { ChatProvider } from '@mcp/provider-sdk/adapter.js';
import type { ChatDelta } from '@mcp/provider-sdk/wire.js';
import { ProviderGatewayError } from './ProviderGatewayError.js';
import { raceAbort } from './ProviderAbort.js';
import { prepareGatewayContext } from './ProviderContextPreparation.js';
import { adaptProviderRequest } from './ProviderRequestAdapter.js';
import type { ProviderGatewayDependencies, ProviderGatewayLimits } from './ProviderGatewayTypes.js';

/** Open only after prepared context and any cold chapters have committed. */
export async function openProviderIterator(
  start: agentV1Runtime.ProviderStart,
  binding: agentV1Runtime.ProviderBinding,
  dependencies: ProviderGatewayDependencies,
  limits: ProviderGatewayLimits,
  signal: AbortSignal,
  beforeProviderOpen?: (start: agentV1Runtime.ProviderStart, signal: AbortSignal) => Promise<void>,
  frontierCommitted?: () => void,
): Promise<AsyncIterator<ChatDelta>> {
  if (start.pendingChapters.length && !beforeProviderOpen) {
    throw new ProviderGatewayError('invalid_provider_request', 'Compacted context requires a durable chapter writer');
  }
  start = await raceAbort(prepareGatewayContext(start, dependencies.contextPreparation, signal, false, !!beforeProviderOpen), signal);
  const request = await raceAbort(adaptProviderRequest(start, dependencies.artifactReader, limits, signal), signal);
  if (beforeProviderOpen) await raceAbort(beforeProviderOpen(start, signal), signal);
  frontierCommitted?.();
  signal.throwIfAborted();
  if (dependencies.admitOperation) await raceAbort(Promise.resolve(dependencies.admitOperation(start.identity!, signal)), signal);
  signal.throwIfAborted();
  const provider = await raceAbort(Promise.resolve(dependencies.resolver.resolve(binding, signal)), signal);
  assertResolvedBinding(provider, binding);
  return provider.chat(request)[Symbol.asyncIterator]();
}

function assertResolvedBinding(provider: ChatProvider, binding: agentV1Runtime.ProviderBinding): void {
  if (provider.name !== binding.effectiveProvider || provider.model !== binding.effectiveModel) {
    throw new ProviderGatewayError('provider_binding_mismatch', 'resolved provider does not match the sealed effective binding');
  }
}
