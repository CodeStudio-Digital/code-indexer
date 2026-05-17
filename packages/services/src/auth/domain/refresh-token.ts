import { ScopeSet } from './scope.js';

export interface RefreshTokenRow {
  token_hash: string;
  client_id: string;
  scopes: string;
  expires_at: number | null;
  created_at: string;
  rotated_to: string | null;
  revoked_at: string | null;
}

/**
 * RefreshToken — long-lived credential to obtain new access tokens.
 * Rotation chain: old token's `rotatedTo` points to the successor's hash.
 */
export class RefreshToken {
  private constructor(
    readonly tokenHash: string,
    readonly clientId: string,
    readonly scopes: ScopeSet,
    readonly expiresAt: number | null,
    readonly createdAt: number,
    readonly rotatedTo: string | null,
    readonly revokedAt: number | null,
  ) {}

  static issue(params: {
    tokenHash: string;
    clientId: string;
    scopes: ScopeSet;
    expiresAt: number | null;
    now: number;
  }): RefreshToken {
    return new RefreshToken(
      params.tokenHash,
      params.clientId,
      params.scopes,
      params.expiresAt,
      params.now,
      null,
      null,
    );
  }

  static fromRow(row: RefreshTokenRow): RefreshToken {
    return new RefreshToken(
      row.token_hash,
      row.client_id,
      ScopeSet.fromJson(row.scopes),
      row.expires_at,
      Date.parse(row.created_at),
      row.rotated_to,
      row.revoked_at ? Date.parse(row.revoked_at) : null,
    );
  }

  isUsable(now: number): boolean {
    if (this.revokedAt !== null) return false;
    if (this.rotatedTo !== null) return false;
    if (this.expiresAt !== null && this.expiresAt <= now) return false;
    return true;
  }
}
