import type { Clock } from '../../../auth/ports/clock.js';
import type { TokenHasher } from '../../../auth/ports/token-hasher.js';
import type { AuthorizationServerMetadata } from '../domain/authorization-server.js';
import { McpOAuthRegistration } from '../domain/oauth-registration.js';
import type { McpOAuthRegistrationAdminRepo } from '../ports/oauth-registration-repository.js';

export interface RegisterManualInput {
  serverId: string;
  asMetadata: AuthorizationServerMetadata;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  scopes: readonly string[];
}

/**
 * Alternative to DCR: user pastes an existing client_id (and optional
 * secret) obtained out-of-band from the AS operator. Same persisted shape.
 */
export class RegisterManualClient {
  constructor(
    private readonly repo: McpOAuthRegistrationAdminRepo,
    private readonly hasher: TokenHasher,
    private readonly clock: Clock,
  ) {}

  execute(input: RegisterManualInput): McpOAuthRegistration {
    const registration = McpOAuthRegistration.create({
      serverId: input.serverId,
      issuer: input.asMetadata.issuer,
      authorizationEndpoint: input.asMetadata.authorizationEndpoint,
      tokenEndpoint: input.asMetadata.tokenEndpoint,
      revocationEndpoint: input.asMetadata.revocationEndpoint ?? null,
      registrationSource: 'manual',
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      clientSecretHash: input.clientSecret ? this.hasher.hash(input.clientSecret) : null,
      scopes: input.scopes,
      redirectUri: input.redirectUri,
      now: this.clock.now(),
    });
    this.repo.upsert(registration);
    return registration;
  }
}
