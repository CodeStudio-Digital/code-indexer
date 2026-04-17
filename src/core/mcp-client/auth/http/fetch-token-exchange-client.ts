import type {
  ExchangeCodeInput,
  RefreshInput,
  RevokeInput,
  TokenExchangeClient,
  TokenResponse,
} from '../ports/token-exchange-client.js';

/**
 * RFC 6749 §4.1.3 (code), §6 (refresh), RFC 7009 (revoke).
 * All three use application/x-www-form-urlencoded bodies.
 *
 * Client auth: for confidential clients we send client_id + client_secret
 * in the body (client_secret_post). HTTP Basic is equivalent but less
 * common in the MCP ecosystem — can be added later.
 */
export class FetchTokenExchangeClient implements TokenExchangeClient {
  async exchangeCode(input: ExchangeCodeInput): Promise<TokenResponse> {
    const body = this.formBody({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    });
    return this.post(input.tokenEndpoint, body);
  }

  async refresh(input: RefreshInput): Promise<TokenResponse> {
    const body = this.formBody({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    });
    return this.post(input.tokenEndpoint, body);
  }

  async revoke(input: RevokeInput): Promise<void> {
    const body = this.formBody({
      token: input.token,
      ...(input.tokenTypeHint ? { token_type_hint: input.tokenTypeHint } : {}),
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    });
    const res = await fetch(input.revocationEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
    // RFC 7009: 200 even for unknown tokens. Still raise on 4xx/5xx other.
    if (!res.ok && res.status !== 200) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  private async post(endpoint: string, body: string): Promise<TokenResponse> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const parsed = (await res.json()) as Record<string, unknown>;
    const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
    if (!accessToken) throw new Error('HTTP 200: response missing access_token');
    const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : null;
    const refreshToken =
      typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null;
    const scopeStr = typeof parsed.scope === 'string' ? parsed.scope : '';
    const tokenType = typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer';
    return {
      accessToken,
      tokenType,
      expiresInSec: expiresIn,
      refreshToken,
      scope: scopeStr ? scopeStr.split(/\s+/).filter(Boolean) : [],
    };
  }

  private formBody(fields: Record<string, string>): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) params.set(k, v);
    return params.toString();
  }
}
