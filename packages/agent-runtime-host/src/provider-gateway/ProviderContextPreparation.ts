import type { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { validatePreparedBoundaryContext } from '../native/PreparedBoundaryContext.js';

export interface ProviderContextPreparationPort {
  prepare(start: wire.ProviderStart, signal: AbortSignal, checkpointOnly: boolean): Promise<{
    context?: wire.ProviderPreparedBoundaryContextV1;
    resetContinuation: boolean;
  }>;
}

/** Authentication acknowledges the original Runner request. The durable
 * frontier separately authenticates the final context actually sent upstream.
 * This port can only supply bounded read-only context, never a provider/tool
 * selection or an effect authority. It runs before request adaptation/commit. */
export async function prepareGatewayContext(start: wire.ProviderStart,
  port: ProviderContextPreparationPort | undefined, signal: AbortSignal, checkpointOnly: boolean, durable = true): Promise<wire.ProviderStart> {
  if (!port) return start;
  if (!durable) throw new Error('Prepared provider context requires a durable frontier writer');
  const prepared = await port.prepare(start, signal, checkpointOnly);
  signal.throwIfAborted();
  validatePreparedBoundaryContext(prepared.context, start.messages);
  return { ...start, preparedBoundaryContext: prepared.context && structuredClone(prepared.context),
    ...(prepared.resetContinuation ? { previousResponseId: undefined, previousResponseMessageCount: undefined } : {}) };
}
