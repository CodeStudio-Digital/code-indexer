import type { Clock } from '../../../auth/ports/clock.js';
import type { TokenHasher } from '../../../auth/ports/token-hasher.js';
import { McpOAuthTokens } from '../domain/oauth-tokens.js';
import type { McpOAuthRegistrationReaderRepo } from '../ports/oauth-registration-repository.js';
import type { McpOAuthTokensAdminRepo } from '../ports/oauth-tokens-repository.js';
import type { PendingAuthorizationRepo } from '../ports/pending-authorization-repository.js';
import type { TokenExchangeClient } from '../ports/token-exchange-client.js';
import { err, ok, type Result } from './result.js';

export interface CompleteInput {
  state: string;
  code: string;
  expectedServerId?: string;
  isCurrent?: () => boolean;
}

export interface CompleteOutput {
  serverId: string;
  scopes: readonly string[];
}

/**
 * Callback handler. Consumes the PendingAuthorization (one-shot), exchanges
 * the code + verifier for tokens, and persists them.
 */
export class CompleteAuthorizationFlow {
  constructor(
    private readonly registrations: McpOAuthRegistrationReaderRepo,
    private readonly pending: PendingAuthorizationRepo,
    private readonly tokens: McpOAuthTokensAdminRepo,
    private readonly exchange: TokenExchangeClient,
    private readonly hasher: TokenHasher,
    private readonly clock: Clock,
  ) {}

  async execute(input: CompleteInput): Promise<Result<CompleteOutput>> {
    const now = this.clock.now();
    const p = this.pending.consume(input.state, now);
    if (!p || (input.expectedServerId && input.expectedServerId !== p.serverId)) return err({ kind: 'invalid_state' });
    if (!p.isUsable(now + 1)) return err({ kind: 'state_expired' });

    const reg = this.registrations.findByServerId(p.serverId);
    if (!reg) return err({ kind: 'registration_not_found', serverId: p.serverId });

    try {
      const response = await this.exchange.exchangeCode({
        tokenEndpoint: reg.tokenEndpoint,
        clientId: reg.clientId,
        clientSecret: reg.clientSecret,
        resourceUrl: reg.resourceUrl,
        tokenEndpointAuthMethod: reg.tokenEndpointAuthMethod,
        code: input.code,
        codeVerifier: p.verifier,
        redirectUri: p.redirectUri,
      });

      if (input.isCurrent && !input.isCurrent()) return err({ kind: 'invalid_state' });
      const accessExpiresAt =
        response.expiresInSec !== null ? this.clock.now() + response.expiresInSec * 1000 : null;

      this.tokens.upsert(
        McpOAuthTokens.issue({
          serverId: p.serverId,
          accessToken: response.accessToken,
          accessExpiresAt,
          refreshRaw: response.refreshToken,
          refreshHash: response.refreshToken ? this.hasher.hash(response.refreshToken) : null,
          scopes: response.scope.length > 0 ? response.scope : p.scopes,
          now,
        }),
      );

      return ok({ serverId: p.serverId, scopes: response.scope.length > 0 ? response.scope : p.scopes });
    } catch (e) {
      const match = /^HTTP (\d+):\s*(.*)$/s.exec(e instanceof Error ? e.message : String(e));
      if (match) return err({ kind: 'token_exchange_failed', status: Number(match[1]), body: match[2] });
      return err({
        kind: 'token_exchange_failed',
        status: 0,
        body: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
