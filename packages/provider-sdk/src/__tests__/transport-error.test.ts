import { describe, expect, it } from 'vitest';
import { providerTransportError } from '../transport-error.js';

describe('provider transport diagnostics', () => {
  it('follows SDK causes and emits only an allowlisted code and fixed message', () => {
    const cause = Object.assign(new Error('https://secret.test/?token=private'), { code: 'ECONNRESET' });
    expect(providerTransportError(new Error('request contains a secret', { cause })))
      .toEqual({ code: 'ECONNRESET', message: 'Provider connection interrupted before the response completed (ECONNRESET)' });
  });
  it('handles an undici termination with unavailable cause without inventing a socket code', () => {
    expect(providerTransportError(new TypeError('terminated'))?.code).toBe('PROVIDER_STREAM_TERMINATED');
  });
  it('does not confuse cancellation, syntax errors or arbitrary terminated messages with transport failure', () => {
    const socket = Object.assign(new Error('closed'), { code: 'UND_ERR_SOCKET' });
    expect(providerTransportError(Object.assign(new Error('cancel', { cause: socket }), { name: 'AbortError' }))).toBeNull();
    expect(providerTransportError(new SyntaxError('unexpected token'))).toBeNull();
    expect(providerTransportError(new Error('terminated'))).toBeNull();
  });
  it('bounds cyclic cause chains', () => {
    const error = new Error('cycle');
    error.cause = error;
    expect(providerTransportError(error)).toBeNull();
  });
});
