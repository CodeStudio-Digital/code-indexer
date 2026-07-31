export function canAttemptLogin({ failedAttempts, lockedUntil }, nowMs) {
  if (lockedUntil == null) return true;
  return failedAttempts < 5 || nowMs >= lockedUntil;
}

