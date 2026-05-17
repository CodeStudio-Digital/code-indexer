/**
 * Metadata exposed by the target MCP server's Protected Resource endpoint
 * (RFC 9728). Tells us which Authorization Server to use.
 */
export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly scopesSupported: readonly string[];
  readonly bearerMethodsSupported: readonly string[];
}

/**
 * Metadata exposed by the Authorization Server itself (RFC 8414).
 * Endpoints + supported flows.
 */
export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly revocationEndpoint?: string;
  readonly scopesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[];
  readonly grantTypesSupported: readonly string[];
  readonly tokenEndpointAuthMethodsSupported: readonly string[];
}

export function asSupportsDcr(meta: AuthorizationServerMetadata): boolean {
  return !!meta.registrationEndpoint;
}

export function asSupportsPkceS256(meta: AuthorizationServerMetadata): boolean {
  return meta.codeChallengeMethodsSupported.includes('S256');
}
