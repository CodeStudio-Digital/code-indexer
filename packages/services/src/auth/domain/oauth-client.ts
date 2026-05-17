import { ScopeSet } from './scope.js';

export type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';
export type GrantType = 'authorization_code' | 'refresh_token';

export interface OAuthClientRow {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string;                     // JSON
  grant_types: string;                       // JSON
  scopes: string;                            // JSON
  token_endpoint_auth_method: string;
  created_at: string;
  revoked_at: string | null;
}

/**
 * OAuthClient — registered via DCR (RFC 7591) or admin.
 * Public clients have `clientSecretHash === null` and must use PKCE.
 */
export class OAuthClient {
  private constructor(
    readonly clientId: string,
    readonly clientSecretHash: string | null,
    readonly clientName: string,
    readonly redirectUris: readonly string[],
    readonly grantTypes: readonly GrantType[],
    readonly scopes: ScopeSet,
    readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod,
    readonly createdAt: number,
    readonly revokedAt: number | null,
  ) {}

  static register(params: {
    clientId: string;
    clientSecretHash: string | null;
    clientName: string;
    redirectUris: readonly string[];
    grantTypes: readonly GrantType[];
    scopes: ScopeSet;
    tokenEndpointAuthMethod: TokenEndpointAuthMethod;
    now: number;
  }): OAuthClient {
    if (params.redirectUris.length === 0) throw new Error('At least one redirect_uri required');
    if (!params.clientName.trim()) throw new Error('client_name cannot be empty');
    if (params.tokenEndpointAuthMethod === 'none' && params.clientSecretHash !== null) {
      throw new Error('Public client must not have a client_secret');
    }
    if (params.tokenEndpointAuthMethod !== 'none' && params.clientSecretHash === null) {
      throw new Error('Confidential client must have a client_secret');
    }
    return new OAuthClient(
      params.clientId,
      params.clientSecretHash,
      params.clientName.trim(),
      params.redirectUris,
      params.grantTypes,
      params.scopes,
      params.tokenEndpointAuthMethod,
      params.now,
      null,
    );
  }

  static fromRow(row: OAuthClientRow): OAuthClient {
    return new OAuthClient(
      row.client_id,
      row.client_secret_hash,
      row.client_name,
      JSON.parse(row.redirect_uris) as string[],
      JSON.parse(row.grant_types) as GrantType[],
      ScopeSet.fromJson(row.scopes),
      row.token_endpoint_auth_method as TokenEndpointAuthMethod,
      Date.parse(row.created_at),
      row.revoked_at ? Date.parse(row.revoked_at) : null,
    );
  }

  isPublic(): boolean {
    return this.tokenEndpointAuthMethod === 'none';
  }

  isRevoked(): boolean {
    return this.revokedAt !== null;
  }

  allowsRedirectUri(uri: string): boolean {
    return this.redirectUris.includes(uri);
  }

  allowsGrantType(gt: string): boolean {
    return (this.grantTypes as readonly string[]).includes(gt);
  }
}
