import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
} from '../domain/authorization-server.js';
import type { DiscoveryClient } from '../ports/discovery-client.js';
import { err, ok, type Result } from './result.js';

export interface DiscoverInput {
  /**
   * Either a Protected Resource Metadata URL (preferred — comes from the
   * `resource_metadata=` param of a 401 WWW-Authenticate header), or the
   * bare MCP server URL (we will try common well-known paths on it).
   */
  resourceUrl: string;
}

export interface DiscoverOutput {
  resource: ProtectedResourceMetadata;
  as: AuthorizationServerMetadata;
}

/**
 * Two-step OAuth discovery:
 * 1. Fetch Protected Resource Metadata → yields one or more AS issuer URLs
 * 2. Fetch the chosen AS's Authorization Server Metadata
 */
export class DiscoverAuthorizationServer {
  constructor(private readonly client: DiscoveryClient) {}

  async execute(input: DiscoverInput): Promise<Result<DiscoverOutput>> {
    let resource: ProtectedResourceMetadata;
    try {
      resource = await this.client.fetchProtectedResourceMetadata(input.resourceUrl);
    } catch (e) {
      return err({ kind: 'discovery_failed', reason: `resource metadata: ${msg(e)}` });
    }

    if (resource.authorizationServers.length === 0) {
      return err({ kind: 'discovery_failed', reason: 'no authorization_servers listed' });
    }

    const issuer = resource.authorizationServers[0];
    let as: AuthorizationServerMetadata;
    try {
      as = await this.client.fetchAuthorizationServerMetadata(issuer);
    } catch (e) {
      return err({ kind: 'discovery_failed', reason: `AS metadata: ${msg(e)}` });
    }

    return ok({ resource, as });
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
