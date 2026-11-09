import type { AuthorizationServerMetadata, ProtectedResourceMetadata } from '@mcp/services/mcp-client/auth/domain/authorization-server.js';

export function authorizationMetadataWire(as: AuthorizationServerMetadata) {
  return {
    issuer: as.issuer, authorization_endpoint: as.authorizationEndpoint, token_endpoint: as.tokenEndpoint,
    registration_endpoint: as.registrationEndpoint, revocation_endpoint: as.revocationEndpoint,
    scopes_supported: as.scopesSupported, code_challenge_methods_supported: as.codeChallengeMethodsSupported,
    grant_types_supported: as.grantTypesSupported, token_endpoint_auth_methods_supported: as.tokenEndpointAuthMethodsSupported,
  };
}
export function resourceMetadataWire(resource: ProtectedResourceMetadata) {
  return { resource: resource.resource, authorization_servers: resource.authorizationServers,
    scopes_supported: resource.scopesSupported, bearer_methods_supported: resource.bearerMethodsSupported };
}
export function parseAuthorizationMetadata(value: unknown): AuthorizationServerMetadata {
  if (!value || typeof value !== 'object') throw new Error('Authorization server metadata is required');
  const v = value as Record<string, unknown>;
  const field = (wire: string, domain: string) => v[wire] ?? v[domain];
  const array = (wire: string, domain: string): string[] => {
    const a = field(wire, domain);
    return Array.isArray(a) && a.every(i => typeof i === 'string') ? a : [];
  };
  const endpoint = (wire: string, domain: string, optional = false): string => {
    const s = field(wire, domain);
    if (optional && !s) return '';
    if (typeof s !== 'string') throw new Error(`Missing ${wire}`);
    const url = new URL(s);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error(`Invalid ${wire}`);
    return s;
  };
  return { issuer: endpoint('issuer', 'issuer'), authorizationEndpoint: endpoint('authorization_endpoint', 'authorizationEndpoint'),
    tokenEndpoint: endpoint('token_endpoint', 'tokenEndpoint'), registrationEndpoint: endpoint('registration_endpoint', 'registrationEndpoint', true) || undefined,
    revocationEndpoint: endpoint('revocation_endpoint', 'revocationEndpoint', true) || undefined,
    scopesSupported: array('scopes_supported', 'scopesSupported'), codeChallengeMethodsSupported: array('code_challenge_methods_supported', 'codeChallengeMethodsSupported'),
    grantTypesSupported: array('grant_types_supported', 'grantTypesSupported'), tokenEndpointAuthMethodsSupported: array('token_endpoint_auth_methods_supported', 'tokenEndpointAuthMethodsSupported') };
}
