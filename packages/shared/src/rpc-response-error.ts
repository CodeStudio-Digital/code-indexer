/** A correlated negative RPC reply, distinct from a lost reply/closed port.
 * The operation reported failure; this does not assert rollback or no effects. */
export class RpcResponseError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'RpcResponseError';
  }
}

const UNCONFIRMED_CODES = new Set([
  'port_closed', 'request_timeout', 'unserializable_response',
  'TOOL_OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN', 'outcome_unknown',
]);

/** Only the transport constructs this class after receiving the matching reply.
 * An explicit uncertain result from a downstream transport remains uncertain. */
export function isConfirmedRpcFailure(error: unknown): error is RpcResponseError {
  return error instanceof RpcResponseError && !UNCONFIRMED_CODES.has(error.code ?? '');
}
