export interface PendingAuthorizationRow {
  state: string;
  server_id: string;
  verifier: string;
  redirect_uri: string;
  scopes: string;
  expires_at: number;
  consumed_at: string | null;
}

/**
 * Short-lived PKCE state. Bound to a server_id so a code received at the
 * callback cannot be "stolen" and redeemed against a different server.
 * The state value is a cryptographically random string used for CSRF.
 */
export class PendingAuthorization {
  private constructor(
    readonly state: string,
    readonly serverId: string,
    readonly verifier: string,
    readonly redirectUri: string,
    readonly scopes: readonly string[],
    readonly expiresAt: number,
    readonly consumedAt: number | null,
  ) {}

  static issue(params: {
    state: string;
    serverId: string;
    verifier: string;
    redirectUri: string;
    scopes: readonly string[];
    ttlMs: number;
    now: number;
  }): PendingAuthorization {
    return new PendingAuthorization(
      params.state,
      params.serverId,
      params.verifier,
      params.redirectUri,
      params.scopes,
      params.now + params.ttlMs,
      null,
    );
  }

  static fromRow(row: PendingAuthorizationRow): PendingAuthorization {
    return new PendingAuthorization(
      row.state,
      row.server_id,
      row.verifier,
      row.redirect_uri,
      JSON.parse(row.scopes) as string[],
      row.expires_at,
      row.consumed_at ? Date.parse(row.consumed_at) : null,
    );
  }

  isUsable(now: number): boolean {
    return this.consumedAt === null && this.expiresAt > now;
  }
}
