import type { Clock } from '../support/ports/clock.js';
import type { TokenHasher } from '../support/ports/token-hasher.js';
import type { AuthorizationServerMetadata } from '../domain/authorization-server.js';
import { asSupportsDcr } from '../domain/authorization-server.js';
import { McpOAuthRegistration } from '../domain/oauth-registration.js';
import type { DcrClient, DcrRequest } from '../ports/dcr-client.js';
import type { McpOAuthRegistrationAdminRepo } from '../ports/oauth-registration-repository.js';
import { err, ok, type Result } from './result.js';

export interface RegisterInput {
  serverId: string;
  resourceUrl?: string;
  asMetadata: AuthorizationServerMetadata;
  clientName: string;
  redirectUri: string;
  scopes: readonly string[];
  /** 'none' → public client (PKCE only). */
  tokenEndpointAuthMethod?: 'none' | 'client_secret_post' | 'client_secret_basic';
}

/**
 * Performs DCR (RFC 7591) against the resolved AS metadata and persists the
 * resulting registration. Fails fast when the AS does not expose a
 * registration_endpoint — callers can fall back to manual registration.
 */
export class RegisterDynamicClient {
  constructor(
    private readonly dcr: DcrClient,
    private readonly repo: McpOAuthRegistrationAdminRepo,
    private readonly hasher: TokenHasher,
    private readonly clock: Clock,
  ) {}

  async execute(input: RegisterInput): Promise<Result<McpOAuthRegistration>> {
    if (!asSupportsDcr(input.asMetadata)) return err({ kind: 'dcr_not_supported' });

    const methods = input.asMetadata.tokenEndpointAuthMethodsSupported;
    const tokenEndpointAuthMethod = input.tokenEndpointAuthMethod ?? (methods.includes('none') || methods.length === 0
      ? 'none' : methods.includes('client_secret_basic') ? 'client_secret_basic' : 'client_secret_post');

    const request: DcrRequest = {
      clientName: input.clientName,
      redirectUris: [input.redirectUri],
      scopes: input.scopes,
      grantTypes: ['authorization_code', 'refresh_token'],
      tokenEndpointAuthMethod,
    };

    try {
      const response = await this.dcr.register(input.asMetadata.registrationEndpoint!, request);
      const registration = McpOAuthRegistration.create({
        serverId: input.serverId,
        resourceUrl: input.resourceUrl,
        tokenEndpointAuthMethod: response.tokenEndpointAuthMethod ?? tokenEndpointAuthMethod,
        issuer: input.asMetadata.issuer,
        authorizationEndpoint: input.asMetadata.authorizationEndpoint,
        tokenEndpoint: input.asMetadata.tokenEndpoint,
        revocationEndpoint: input.asMetadata.revocationEndpoint ?? null,
        registrationSource: 'dcr',
        clientId: response.clientId,
        clientSecret: response.clientSecret,
        clientSecretHash: response.clientSecret ? this.hasher.hash(response.clientSecret) : null,
        scopes: input.scopes,
        redirectUri: input.redirectUri,
        now: this.clock.now(),
      });
      this.repo.upsert(registration);
      return ok(registration);
    } catch (e) {
      const match = /^HTTP (\d+):\s*(.*)$/s.exec(e instanceof Error ? e.message : String(e));
      if (match) {
        return err({ kind: 'dcr_failed', status: Number(match[1]), body: match[2] });
      }
      return err({ kind: 'dcr_failed', status: 0, body: e instanceof Error ? e.message : String(e) });
    }
  }
}
