export interface McpOAuthTokensRow {
  server_id: string;
  access_token: string;
  access_expires_at: number | null;
  refresh_raw: string | null;
  refresh_hash: string | null;
  scopes: string;
  updated_at: string;
}

/**
 * Active access + refresh token pair for a given MCP server.
 * Replaced on every successful refresh (rotation).
 */
export class McpOAuthTokens {
  private constructor(
    readonly serverId: string,
    readonly accessToken: string,
    readonly accessExpiresAt: number | null,
    readonly refreshRaw: string | null,
    readonly refreshHash: string | null,
    readonly scopes: readonly string[],
    readonly updatedAt: number,
  ) {}

  static issue(params: {
    serverId: string;
    accessToken: string;
    accessExpiresAt: number | null;
    refreshRaw: string | null;
    refreshHash: string | null;
    scopes: readonly string[];
    now: number;
  }): McpOAuthTokens {
    if (!params.accessToken) throw new Error('accessToken required');
    return new McpOAuthTokens(
      params.serverId,
      params.accessToken,
      params.accessExpiresAt,
      params.refreshRaw,
      params.refreshHash,
      params.scopes,
      params.now,
    );
  }

  static fromRow(row: McpOAuthTokensRow): McpOAuthTokens {
    return new McpOAuthTokens(
      row.server_id,
      row.access_token,
      row.access_expires_at,
      row.refresh_raw,
      row.refresh_hash,
      JSON.parse(row.scopes) as string[],
      Date.parse(row.updated_at),
    );
  }

  /**
   * Access tokens have a small safety margin so in-flight calls don't race
   * a refresh that completes after the token's precise expiry.
   */
  needsRefresh(now: number, marginMs: number = 60_000): boolean {
    if (this.accessExpiresAt === null) return false;
    return this.accessExpiresAt - marginMs <= now;
  }

  isExpired(now: number): boolean {
    return this.accessExpiresAt !== null && this.accessExpiresAt <= now;
  }
}
