import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
} from '../domain/authorization-server.js';

/**
 * Client-side discovery facade. Both methods resolve to parsed metadata
 * VOs; they fail by throwing — the DiscoverAuthorizationServer use-case
 * catches and converts to a domain error.
 */
export interface DiscoveryClient {
  fetchProtectedResourceMetadata(resourceUrl: string): Promise<ProtectedResourceMetadata>;
  fetchAuthorizationServerMetadata(issuer: string): Promise<AuthorizationServerMetadata>;
}
