import type { Clock } from '../../../auth/ports/clock.js';
import type { McpOAuthTokensReaderRepo } from '../ports/oauth-tokens-repository.js';
import type { RefreshMcpAccessToken } from './refresh-mcp-access-token.js';
import { err, ok, type Result } from './result.js';

/**
 * ResolveMcpBearer — single entry point consumed by McpServerManager.
 *
 * Guarantees: returns a fresh-enough access token (within a 60s safety
 * margin) or a domain error that tells the caller the server needs
 * re-auth. Refresh is implicit and silent.
 */
export class ResolveMcpBearer {
  constructor(
    private readonly tokens: McpOAuthTokensReaderRepo,
    private readonly refresh: RefreshMcpAccessToken,
    private readonly clock: Clock,
  ) {}

  async execute(serverId: string): Promise<Result<string>> {
    const existing = this.tokens.findByServerId(serverId);
    if (!existing) return err({ kind: 'tokens_not_found', serverId });

    const now = this.clock.now();
    if (!existing.needsRefresh(now)) return ok(existing.accessToken);

    const refreshed = await this.refresh.execute({ serverId });
    if (!refreshed.ok) return err(refreshed.error);
    return ok(refreshed.value.accessToken);
  }
}
