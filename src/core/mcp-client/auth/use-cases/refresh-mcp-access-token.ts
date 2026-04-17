import type { Clock } from '../../../auth/ports/clock.js';
import type { TokenHasher } from '../../../auth/ports/token-hasher.js';
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
 * Reuse detection: if the refresh_token presented differs from what we
 * currently have (i.e., older one being replayed), we assume theft and
 * revoke everything for that server by deleting the tokens row.
 */
export class RefreshMcpAccessToken {
  constructor(
    private readonly registrations: McpOAuthRegistrationReaderRepo,
    private readonly tokensReader: McpOAuthTokensReaderRepo,
    private readonly tokensAdmin: McpOAuthTokensAdminRepo,
    private readonly exchange: TokenExchangeClient,
    private readonly hasher: TokenHasher,
    private readonly clock: Clock,
  ) {}

  async execute(input: RefreshInput): Promise<Result<RefreshOutput>> {
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
        refreshToken: existing.refreshRaw,
      });

      const now = this.clock.now();
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
      // AS rejected the refresh — the most common cause in a healthy system
      // is the refresh token having been revoked or rotated elsewhere.
      // We purge our state so the user is forced to re-auth via UI.
      this.tokensAdmin.delete(input.serverId);
      if (match) return err({ kind: 'refresh_failed', status: Number(match[1]), body: match[2] });
      return err({
        kind: 'refresh_failed',
        status: 0,
        body: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
