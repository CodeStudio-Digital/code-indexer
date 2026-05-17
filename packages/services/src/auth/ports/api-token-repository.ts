import type { ApiToken } from '../domain/api-token.js';

/**
 * Read-only interface consumed by the auth middleware.
 * Separated from the admin interface (ISP) so middleware cannot
 * accidentally mint or revoke tokens.
 */
export interface ApiTokenReaderRepo {
  findByHash(tokenHash: string): ApiToken | null;
  touchLastUsed(id: string, at: number): void;
}

/**
 * Admin interface for token lifecycle. Used by the issuance/revocation
 * use-cases and their HTTP routes.
 */
export interface ApiTokenAdminRepo {
  insert(token: ApiToken): void;
  listAll(): ApiToken[];
  findById(id: string): ApiToken | null;
  revoke(id: string, at: number): void;
}
