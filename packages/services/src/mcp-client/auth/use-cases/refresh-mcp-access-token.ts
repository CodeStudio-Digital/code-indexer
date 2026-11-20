import type { Clock } from '../support/ports/clock.js';
import type { TokenHasher } from '../support/ports/token-hasher.js';
import { McpOAuthTokens } from '../domain/oauth-tokens.js';
import type { McpOAuthRegistrationReaderRepo } from '../ports/oauth-registration-repository.js';
import type {
  McpOAuthTokensAdminRepo,
  McpOAuthTokensReaderRepo,
} from '../ports/oauth-tokens-repository.js';
import type { TokenExchangeClient } from '../ports/token-exchange-client.js';
import { err, ok, type Result } from './result.js';

export interface RefreshInput {
  serverId: string;
}

export interface RefreshOutput {
  accessToken: string;
  expiresAt: number | null;
}

/**
 * Uses the stored refresh token to obtain a new access+refresh pair.
 *
 * Concurrent refreshes share one request. Late results cannot overwrite a
 * newer login or restore credentials after disconnect.
 */
export class RefreshMcpAccessToken {
  private readonly inFlight = new Map<string, Promise<Result<RefreshOutput>>>();
  constructor(
    private readonly registrations: McpOAuthRegistrationReaderRepo,
    private readonly tokensReader: McpOAuthTokensReaderRepo,
    private readonly tokensAdmin: McpOAuthTokensAdminRepo,
    private readonly exchange: TokenExchangeClient,
    private readonly hasher: TokenHasher,
    private readonly clock: Clock,
  ) {}

  async execute(input: RefreshInput): Promise<Result<RefreshOutput>> {
    const active = this.inFlight.get(input.serverId);
    if (active) return active;
    const task = this.refreshOnce(input);
    this.inFlight.set(input.serverId, task);
    try { return await task; }
    finally { if (this.inFlight.get(input.serverId) === task) this.inFlight.delete(input.serverId); }
  }

  private async refreshOnce(input: RefreshInput): Promise<Result<RefreshOutput>> {
    const reg = this.registrations.findByServerId(input.serverId);
    if (!reg) return err({ kind: 'registration_not_found', serverId: input.serverId });

    const existing = this.tokensReader.findByServerId(input.serverId);
    if (!existing || !existing.refreshRaw) {
      return err({ kind: 'tokens_not_found', serverId: input.serverId });
    }

    try {
      const response = await this.exchange.refresh({
        tokenEndpoint: reg.tokenEndpoint,
        clientId: reg.clientId,
        clientSecret: reg.clientSecret,
        resourceUrl: reg.resourceUrl,
        tokenEndpointAuthMethod: reg.tokenEndpointAuthMethod,
        refreshToken: existing.refreshRaw,
      });

      const now = this.clock.now();
      // Disconnect/re-authentication may have won during the network request.
      if (this.tokensReader.findByServerId(input.serverId)?.accessToken !== existing.accessToken
        || this.registrations.findByServerId(input.serverId)?.clientId !== reg.clientId) {
        return err({ kind: 'tokens_not_found', serverId: input.serverId });
      }
      const accessExpiresAt =
        response.expiresInSec !== null ? now + response.expiresInSec * 1000 : null;

      // AS MAY omit refresh_token in the response (not rotating). Keep the
      // existing one in that case.
      const newRefreshRaw = response.refreshToken ?? existing.refreshRaw;
      const newRefreshHash = response.refreshToken
        ? this.hasher.hash(response.refreshToken)
        : existing.refreshHash;

      this.tokensAdmin.upsert(
        McpOAuthTokens.issue({
          serverId: input.serverId,
          accessToken: response.accessToken,
          accessExpiresAt,
          refreshRaw: newRefreshRaw,
          refreshHash: newRefreshHash,
          scopes: response.scope.length > 0 ? response.scope : existing.scopes,
          now,
        }),
      );

      return ok({ accessToken: response.accessToken, expiresAt: accessExpiresAt });
    } catch (e) {
      const match = /^HTTP (\d+):\s*(.*)$/s.exec(e instanceof Error ? e.message : String(e));
      let invalidGrant = false;
      try { invalidGrant = !!match && JSON.parse(match[2]).error === 'invalid_grant'; } catch { /* non-JSON error */ }
      // Preserve credentials on network errors, timeout, rate limits and 5xx.
      if (invalidGrant && this.tokensReader.findByServerId(input.serverId)?.accessToken === existing.accessToken) {
        this.tokensAdmin.delete(input.serverId);
      }
      if (match) return err({ kind: 'refresh_failed', status: Number(match[1]), body: match[2] });
      return err({
        kind: 'refresh_failed',
        status: 0,
        body: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
