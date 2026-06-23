import { OAuthClient, type GrantType, type TokenEndpointAuthMethod } from '../domain/oauth-client.js';
import { ScopeSet } from '../domain/scope.js';
import type { OAuthClientAdminRepo } from '../ports/oauth-client-repository.js';
import type { Clock } from '../ports/clock.js';
import type { RandomId } from '../ports/random-id.js';
import type { TokenHasher } from '../ports/token-hasher.js';

export interface RegisterInput {
  clientName: string;
  redirectUris: readonly string[];
  grantTypes?: readonly GrantType[];
  scopes?: readonly string[];
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}

export interface RegisterOutput {
  clientId: string;
  clientSecret: string | null; // null for public clients (PKCE)
}

/**
 * RegisterOAuthClient — Dynamic Client Registration (RFC 7591).
 * Defaults to a public client (PKCE-only) as recommended by the MCP
 * Authorization spec for native app scenarios.
 */
export class RegisterOAuthClient {
  constructor(
    private readonly repo: OAuthClientAdminRepo,
    private readonly random: RandomId,
    private readonly hasher: TokenHasher,
    private readonly clock: Clock,
  ) {}

  execute(input: RegisterInput): RegisterOutput {
    const tokenEndpointAuthMethod: TokenEndpointAuthMethod =
      input.tokenEndpointAuthMethod ?? 'none';

    const clientId = this.random.uuid();
    const clientSecret =
      tokenEndpointAuthMethod === 'none' ? null : this.random.token(32);
    const clientSecretHash = clientSecret ? this.hasher.hash(clientSecret) : null;

    const client = OAuthClient.register({
      clientId,
      clientSecretHash,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      grantTypes: input.grantTypes ?? ['authorization_code', 'refresh_token'],
      scopes: ScopeSet.of(input.scopes ?? ['mcp:read', 'mcp:write']),
      tokenEndpointAuthMethod,
      now: this.clock.now(),
    });

    this.repo.insert(client);
    return { clientId, clientSecret };
  }
}
