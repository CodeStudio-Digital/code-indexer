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
  private readonly rejected = new Map<string, string>();
  constructor(
    private readonly tokens: McpOAuthTokensReaderRepo,
    private readonly refresh: RefreshMcpAccessToken,
    private readonly clock: Clock,
  ) {}

  async execute(serverId: string): Promise<Result<string>> {
    const existing = this.tokens.findByServerId(serverId);
    if (!existing) return err({ kind: 'tokens_not_found', serverId });

    const now = this.clock.now();
    const rejected = this.rejected.get(serverId) === existing.accessToken;
    if (!rejected && (!existing.needsRefresh(now) || (!existing.refreshRaw && !existing.isExpired(now)))) return ok(existing.accessToken);

    const refreshed = await this.refresh.execute({ serverId });
    if (!refreshed.ok) return err(refreshed.error);
    this.rejected.delete(serverId);
    return ok(refreshed.value.accessToken);
  }

  /** A 401 invalidates this bearer for the next request; the failed call is never replayed. */
  rejectToken(serverId: string, token: string): void { this.rejected.set(serverId, token); }
}
