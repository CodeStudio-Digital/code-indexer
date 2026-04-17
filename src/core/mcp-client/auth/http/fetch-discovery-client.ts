import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
} from '../domain/authorization-server.js';
import type { DiscoveryClient } from '../ports/discovery-client.js';

/**
 * Thin wrapper around globalThis.fetch that understands RFC 8414/9728
 * JSON shapes. Throws on non-200 or parse error — the use-case catches.
 *
 * The well-known paths are appended to the base URL when the caller
 * passes a bare origin (common path when recovering from a 401 without a
 * resource_metadata hint).
 */
export class FetchDiscoveryClient implements DiscoveryClient {
  async fetchProtectedResourceMetadata(
    resourceUrl: string,
  ): Promise<ProtectedResourceMetadata> {
    const url = ensureWellKnown(resourceUrl, '/.well-known/oauth-protected-resource');
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      resource: stringField(body, 'resource'),
      authorizationServers: stringArray(body, 'authorization_servers'),
      scopesSupported: stringArray(body, 'scopes_supported'),
      bearerMethodsSupported: stringArray(body, 'bearer_methods_supported'),
    };
  }

  async fetchAuthorizationServerMetadata(
    issuer: string,
  ): Promise<AuthorizationServerMetadata> {
    const url = ensureWellKnown(issuer, '/.well-known/oauth-authorization-server');
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      issuer: stringField(body, 'issuer'),
      authorizationEndpoint: stringField(body, 'authorization_endpoint'),
      tokenEndpoint: stringField(body, 'token_endpoint'),
      registrationEndpoint: optionalString(body, 'registration_endpoint'),
      revocationEndpoint: optionalString(body, 'revocation_endpoint'),
      scopesSupported: stringArray(body, 'scopes_supported'),
      codeChallengeMethodsSupported: stringArray(body, 'code_challenge_methods_supported'),
      grantTypesSupported: stringArray(body, 'grant_types_supported'),
      tokenEndpointAuthMethodsSupported: stringArray(
        body,
        'token_endpoint_auth_methods_supported',
      ),
    };
  }
}

function ensureWellKnown(input: string, suffix: string): string {
  const trimmed = input.replace(/\/+$/, '');
  if (trimmed.includes('/.well-known/')) return trimmed;
  return trimmed + suffix;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  return typeof v === 'string' ? v : '';
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function stringArray(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return [];
}
