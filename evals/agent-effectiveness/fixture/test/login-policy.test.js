import assert from 'node:assert/strict';
import test from 'node:test';
import { canAttemptLogin } from '../src/auth/login-policy.js';

test('allows a user without an active lock', () => {
  assert.equal(canAttemptLogin({ failedAttempts: 0, lockedUntil: null }, 100), true);
});

