import type { PendingAuthorization } from '../domain/pending-authorization.js';

export interface PendingAuthorizationRepo {
  insert(pending: PendingAuthorization): void;
  /**
   * Atomic consume: marks the row as used and returns it. Null if the
   * state is unknown or already consumed.
   */
  consume(state: string, at: number): PendingAuthorization | null;
  purgeExpired(before: number): void;
}
