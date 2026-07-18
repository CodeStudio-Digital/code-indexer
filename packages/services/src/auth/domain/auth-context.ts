import type { ScopeSet } from './scope.js';
import type { McpConnectionPolicy, McpTier } from './api-token.js';

export type TokenType = 'api_token' | 'oauth';

/**
 * AuthContext — value object representing an authenticated caller.
 * Flows through middleware → transport → tool handler as the per-request
 * identity. Immutable.
 */
export interface AuthContext {
  readonly principal: string;       // api_token id OR oauth client_id
  readonly tokenType: TokenType;
  readonly scopes: ScopeSet;
  readonly expiresAt: number | null; // unix ms, null = no expiry
  readonly requestId: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  /**
   * Optional MCP tier this caller is bound to. Set only for API tokens
   * created with a tier (migration 104+). When present, the MCP HTTP
   * transport uses it to filter/gate tools in addition to scope checks.
   */
  readonly tier?: McpTier | null;
  /** Optional persistent project/tool/agent policy bound to the API token. */
  readonly policy?: McpConnectionPolicy | null;
}
