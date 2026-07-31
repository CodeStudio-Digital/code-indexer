import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateExpiry, isSessionExpired, SESSION_TTL_MS } from '../src/auth/session-policy.js';
import { issueToken } from '../src/auth/token-service.js';

test('session expiry is derived from the central TTL policy', () => {
  const issuedAt = 1_700_000_000_000;
  const token = issueToken('u1', issuedAt);
  assert.equal(token.expiresAt, issuedAt + SESSION_TTL_MS);
  assert.equal(calculateExpiry(issuedAt), token.expiresAt);
  assert.equal(isSessionExpired(token, token.expiresAt - 1), false);
  assert.equal(isSessionExpired(token, token.expiresAt), true);
});

