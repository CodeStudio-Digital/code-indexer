import { ScopeSet } from './scope.js';

export interface ApiTokenRow {
  id: string;
  token_hash: string;
  name: string;
  scopes: string;        // JSON array
  expires_at: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * ApiToken — persisted bearer token. Construction goes through factories
 * to prevent invalid state; raw token is never stored (only hash).
 */
export class ApiToken {
  private constructor(
    readonly id: string,
    readonly tokenHash: string,
    readonly name: string,
    readonly scopes: ScopeSet,
    readonly expiresAt: number | null,
    readonly createdAt: number,
    readonly lastUsedAt: number | null,
    readonly revokedAt: number | null,
  ) {}

  static issue(params: {
    id: string;
    tokenHash: string;
    name: string;
    scopes: ScopeSet;
    expiresAt: number | null;
    now: number;
  }): ApiToken {
    if (!params.name.trim()) throw new Error('ApiToken name cannot be empty');
    if (params.scopes.isEmpty()) throw new Error('ApiToken must have at least one scope');
    return new ApiToken(
      params.id,
      params.tokenHash,
      params.name.trim(),
      params.scopes,
      params.expiresAt,
      params.now,
      null,
      null,
    );
  }

  static fromRow(row: ApiTokenRow): ApiToken {
    return new ApiToken(
      row.id,
      row.token_hash,
      row.name,
      ScopeSet.fromJson(row.scopes),
      row.expires_at,
      Date.parse(row.created_at),
      row.last_used_at ? Date.parse(row.last_used_at) : null,
      row.revoked_at ? Date.parse(row.revoked_at) : null,
    );
  }

  isRevoked(): boolean {
    return this.revokedAt !== null;
  }

  isExpired(now: number): boolean {
    return this.expiresAt !== null && this.expiresAt <= now;
  }

  isUsable(now: number): boolean {
    return !this.isRevoked() && !this.isExpired(now);
  }
}
