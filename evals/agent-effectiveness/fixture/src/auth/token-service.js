import { calculateExpiry } from './session-policy.js';

export function issueToken(userId, issuedAtMs) {
  return {
    token: `tok_${userId}_${issuedAtMs}`,
    userId,
    issuedAt: issuedAtMs,
    expiresAt: calculateExpiry(issuedAtMs),
  };
}

