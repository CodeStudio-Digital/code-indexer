import type { McpOAuthTokens } from '../domain/oauth-tokens.js';

export interface McpOAuthTokensReaderRepo {
  findByServerId(serverId: string): McpOAuthTokens | null;
}

export interface McpOAuthTokensAdminRepo {
  upsert(tokens: McpOAuthTokens): void;
  delete(serverId: string): void;
}
