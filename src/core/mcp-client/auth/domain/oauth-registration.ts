export type RegistrationSource = 'dcr' | 'manual';

export interface McpOAuthRegistrationRow {
  server_id: string;
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string | null;
  registration_source: string;
  client_id: string;
  client_secret: string | null;         // raw secret, needed for client_secret_post / basic
  client_secret_hash: string | null;    // stored for defense-in-depth equality checks
  scopes: string;                        // JSON array
  redirect_uri: string;
  created_at: string;
}

/**
 * One-to-one with mcp_server_configs.id: each external MCP server has at
 * most one current registration. Re-registering overwrites.
 */
export class McpOAuthRegistration {
  private constructor(
    readonly serverId: string,
    readonly issuer: string,
    readonly authorizationEndpoint: string,
    readonly tokenEndpoint: string,
    readonly revocationEndpoint: string | null,
    readonly registrationSource: RegistrationSource,
    readonly clientId: string,
    readonly clientSecret: string | null,
    readonly clientSecretHash: string | null,
    readonly scopes: readonly string[],
    readonly redirectUri: string,
    readonly createdAt: number,
  ) {}

  static create(params: {
    serverId: string;
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint?: string | null;
    registrationSource: RegistrationSource;
    clientId: string;
    clientSecret?: string | null;
    clientSecretHash?: string | null;
    scopes: readonly string[];
    redirectUri: string;
    now: number;
  }): McpOAuthRegistration {
    if (!params.clientId) throw new Error('clientId is required');
    if (!params.redirectUri) throw new Error('redirectUri is required');
    return new McpOAuthRegistration(
      params.serverId,
      params.issuer,
      params.authorizationEndpoint,
      params.tokenEndpoint,
      params.revocationEndpoint ?? null,
      params.registrationSource,
      params.clientId,
      params.clientSecret ?? null,
      params.clientSecretHash ?? null,
      params.scopes,
      params.redirectUri,
      params.now,
    );
  }

  static fromRow(row: McpOAuthRegistrationRow): McpOAuthRegistration {
    return new McpOAuthRegistration(
      row.server_id,
      row.issuer,
      row.authorization_endpoint,
      row.token_endpoint,
      row.revocation_endpoint,
      row.registration_source as RegistrationSource,
      row.client_id,
      row.client_secret,
      row.client_secret_hash,
      JSON.parse(row.scopes) as string[],
      row.redirect_uri,
      Date.parse(row.created_at),
    );
  }

  isPublic(): boolean {
    return this.clientSecret === null;
  }
}
