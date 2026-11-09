/** Safe transport diagnostics. Never copy socket addresses, URLs or SDK bodies. */
const TRANSPORT_CODES = new Set([
  'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
  'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND',
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT', 'TIMEOUT',
  'PROVIDER_STREAM_TERMINATED',
]);

export function isProviderTransportCode(code: string | undefined): boolean {
  return code !== undefined && TRANSPORT_CODES.has(code);
}

export interface ProviderTransportError {
  code: string;
  message: string;
}

export function providerTransportError(error: unknown): ProviderTransportError | null {
  const seen = new Set<object>();
  let current = error;
  let code: string | undefined;
  let terminated = false;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const record = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    // A caller cancellation is never a recoverable socket failure.
    if (record.name === 'AbortError' || record.code === 'ABORTED' || record.code === 'ABORT_ERR') return null;
    if (typeof record.code === 'string' && isProviderTransportCode(record.code)) code = record.code;
    if (record.name === 'TypeError' && record.message === 'terminated') terminated = true;
    current = record.cause;
  }
  code ??= terminated ? 'PROVIDER_STREAM_TERMINATED' : undefined;
  if (!code) return null;
  const detail = code === 'PROVIDER_STREAM_TERMINATED'
    ? 'HTTP response stream terminated; the transport did not provide a more specific cause'
    : code.includes('TIMEOUT') || code === 'ETIMEDOUT'
      ? 'Provider transport timed out before the response completed'
      : 'Provider connection interrupted before the response completed';
  return { code, message: `${detail} (${code})` };
}
