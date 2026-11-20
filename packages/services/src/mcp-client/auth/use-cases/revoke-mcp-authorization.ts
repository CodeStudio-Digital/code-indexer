import type { Clock } from '../support/ports/clock.js';
import type {
  McpOAuthRegistrationAdminRepo,
  McpOAuthRegistrationReaderRepo,
} from '../ports/oauth-registration-repository.js';
import type {
  McpOAuthTokensAdminRepo,
  McpOAuthTokensReaderRepo,
} from '../ports/oauth-tokens-repository.js';
import type { TokenExchangeClient } from '../ports/token-exchange-client.js';

/**
 * RFC 7009 revoke (best-effort) + local purge.
 *
 * We attempt to call the AS's revocation_endpoint, but the local state is
 * always cleared even if the network call fails — the user clicked
 * "disconnect", so they want it gone regardless.
 */
export class RevokeMcpAuthorization {
  constructor(
    private readonly regReader: McpOAuthRegistrationReaderRepo,
    private readonly regAdmin: McpOAuthRegistrationAdminRepo,
    private readonly tokensReader: McpOAuthTokensReaderRepo,
    private readonly tokensAdmin: McpOAuthTokensAdminRepo,
    private readonly exchange: TokenExchangeClient,
    private readonly _clock: Clock,
  ) {}

  async execute(serverId: string): Promise<void> {
    const reg = this.regReader.findByServerId(serverId);
    const tokens = this.tokensReader.findByServerId(serverId);

    this.tokensAdmin.delete(serverId);
    this.regAdmin.delete(serverId);

    if (reg?.revocationEndpoint && tokens?.refreshRaw) {
      try {
        await this.exchange.revoke({
          revocationEndpoint: reg.revocationEndpoint,
          clientId: reg.clientId,
          clientSecret: reg.clientSecret,
          tokenEndpointAuthMethod: reg.tokenEndpointAuthMethod,
          token: tokens.refreshRaw,
          tokenTypeHint: 'refresh_token',
        });
      } catch {
        /* best effort — local state is the source of truth */
      }
    }

  }
}
