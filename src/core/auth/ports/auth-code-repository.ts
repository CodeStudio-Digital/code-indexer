import type { AuthCode } from '../domain/auth-code.js';

export interface AuthCodeRepo {
  insert(code: AuthCode): void;
  /**
   * One-shot consume: atomically marks the code as used and returns it.
   * Returns null if already consumed or not found. Callers must still
   * check expiration via `AuthCode.isUsable(now)`.
   */
  consume(code: string, at: number): AuthCode | null;
  purgeExpired(before: number): void;
}
