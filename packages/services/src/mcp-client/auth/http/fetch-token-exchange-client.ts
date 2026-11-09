import type { ExchangeCodeInput, RefreshInput, RevokeInput, TokenExchangeClient, TokenResponse } from '../ports/token-exchange-client.js';

type ClientAuth = Pick<ExchangeCodeInput, 'clientId' | 'clientSecret' | 'tokenEndpointAuthMethod'>;
function request(endpoint: string, fields: Record<string, string>, client: ClientAuth): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const body = new URLSearchParams(fields);
  if (client.clientSecret && client.tokenEndpointAuthMethod === 'client_secret_basic') {
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    headers.Authorization = `Basic ${Buffer.from(`${encode(client.clientId)}:${encode(client.clientSecret)}`).toString('base64')}`;
  } else {
    body.set('client_id', client.clientId);
    if (client.clientSecret) body.set('client_secret', client.clientSecret);
  }
  return fetch(endpoint, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(15_000), redirect: 'error' });
}
async function tokenResponse(res: Response): Promise<TokenResponse> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const parsed = await res.json() as Record<string, unknown>;
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) throw new Error('HTTP 200: response missing access_token');
  if (typeof parsed.token_type === 'string' && parsed.token_type.toLowerCase() !== 'bearer') throw new Error('Unsupported OAuth token type');
  const expires = Number(parsed.expires_in);
  return {
    accessToken: parsed.access_token, tokenType: 'Bearer',
    expiresInSec: parsed.expires_in != null && Number.isFinite(expires) && expires >= 0 ? expires : null,
    refreshToken: typeof parsed.refresh_token === 'string' && parsed.refresh_token ? parsed.refresh_token : null,
    scope: typeof parsed.scope === 'string' ? parsed.scope.split(/\s+/).filter(Boolean) : [],
  };
}
export class FetchTokenExchangeClient implements TokenExchangeClient {
  async exchangeCode(input: ExchangeCodeInput): Promise<TokenResponse> {
    return tokenResponse(await request(input.tokenEndpoint, {
      grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier, ...(input.resourceUrl ? { resource: input.resourceUrl } : {}),
    }, input));
  }
  async refresh(input: RefreshInput): Promise<TokenResponse> {
    return tokenResponse(await request(input.tokenEndpoint, {
      grant_type: 'refresh_token', refresh_token: input.refreshToken,
      ...(input.resourceUrl ? { resource: input.resourceUrl } : {}),
    }, input));
  }
  async revoke(input: RevokeInput): Promise<void> {
    const res = await request(input.revocationEndpoint, {
      token: input.token, ...(input.tokenTypeHint ? { token_type_hint: input.tokenTypeHint } : {}),
    }, input);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    await res.body?.cancel();
  }
}
