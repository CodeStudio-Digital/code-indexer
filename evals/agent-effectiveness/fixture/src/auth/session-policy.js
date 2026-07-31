export const SESSION_TTL_MS = 30 * 60 * 1000;

export function calculateExpiry(issuedAtMs) {
  return issuedAtMs + SESSION_TTL_MS;
}

export function isSessionExpired(session, nowMs) {
  return nowMs >= session.expiresAt;
}

