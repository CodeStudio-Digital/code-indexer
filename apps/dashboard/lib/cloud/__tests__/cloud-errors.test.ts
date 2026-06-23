/** mapCloudError — code-first, status-fallback mapping to UI intents. */
import { describe, it, expect } from 'vitest';
import { mapCloudError, CloudError } from '../cloud-errors.js';

describe('mapCloudError', () => {
  it('maps security-critical codes regardless of status', () => {
    expect(mapCloudError(409, { code: 'token_reuse', message: 'revoked' }).kind).toBe('forced_logout');
    expect(mapCloudError(401, { code: 'twofa_required', message: 'x', details: { challengeToken: 't' } }).kind).toBe('twofa_required');
    expect(mapCloudError(403, { code: 'turnstile_failed' }).kind).toBe('bot_check');
    expect(mapCloudError(402, { code: 'sharing_not_entitled' }).kind).toBe('entitlement');
  });
  it('falls back to status when the code is unknown/absent', () => {
    expect(mapCloudError(0, {}).kind).toBe('offline');
    expect(mapCloudError(401, {}).kind).toBe('auth_required');
    expect(mapCloudError(423, {}).kind).toBe('auth_required');
    expect(mapCloudError(402, {}).kind).toBe('entitlement');
    expect(mapCloudError(404, {}).kind).toBe('not_found');
    expect(mapCloudError(413, {}).kind).toBe('too_large');
    expect(mapCloudError(429, {}).kind).toBe('rate_limited');
    expect(mapCloudError(500, {}).kind).toBe('server_error');
    expect(mapCloudError(418, {}).kind).toBe('unknown');
  });
  it('preserves the server message + code + details and is a CloudError', () => {
    const e = mapCloudError(400, { code: 'validation_failed', message: 'bad email', details: { field: 'email' } });
    expect(e).toBeInstanceOf(CloudError);
    expect(e.kind).toBe('invalid_input');
    expect(e.message).toBe('bad email');
    expect(e.code).toBe('validation_failed');
    expect(e.details).toEqual({ field: 'email' });
  });
});
