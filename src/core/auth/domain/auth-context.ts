import type { ScopeSet } from './scope.js';

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
}
