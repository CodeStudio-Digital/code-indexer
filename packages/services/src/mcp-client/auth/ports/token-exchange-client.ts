export interface ExchangeCodeInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  resourceUrl?: string | null;
  tokenEndpointAuthMethod?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface RefreshInput {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  resourceUrl?: string | null;
  tokenEndpointAuthMethod?: string;
  refreshToken: string;
}

export interface RevokeInput {
  revocationEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  resourceUrl?: string | null;
  tokenEndpointAuthMethod?: string;
  token: string;
  tokenTypeHint?: 'access_token' | 'refresh_token';
}

export interface TokenResponse {
  accessToken: string;
  tokenType: string;                // 'Bearer' per RFC 6749
  expiresInSec: number | null;
  refreshToken: string | null;
  scope: readonly string[];
}

/**
 * HTTP-side of the OAuth token endpoint. All three operations go to
 * `token_endpoint`/`revocation_endpoint`; keeping them on one port keeps
 * the adapter cohesive.
 */
export interface TokenExchangeClient {
  exchangeCode(input: ExchangeCodeInput): Promise<TokenResponse>;
  refresh(input: RefreshInput): Promise<TokenResponse>;
  revoke(input: RevokeInput): Promise<void>;
}
