import type { DcrClient, DcrRequest, DcrResponse } from '../ports/dcr-client.js';

/**
 * RFC 7591 Dynamic Client Registration over HTTPS.
 * Body is JSON per the spec.
 */
export class FetchDcrClient implements DcrClient {
  async register(registrationEndpoint: string, request: DcrRequest): Promise<DcrResponse> {
    const body = {
      client_name: request.clientName,
      redirect_uris: request.redirectUris,
      grant_types: request.grantTypes,
      response_types: ['code'],
      scope: request.scopes.join(' '),
      token_endpoint_auth_method: request.tokenEndpointAuthMethod,
    };

    const res = await fetch(registrationEndpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

    const parsed = (await res.json()) as Record<string, unknown>;
    const clientId = typeof parsed.client_id === 'string' ? parsed.client_id : '';
    if (!clientId) throw new Error('HTTP 200: response missing client_id');
    const clientSecret =
      typeof parsed.client_secret === 'string' ? parsed.client_secret : null;
    const method = typeof parsed.token_endpoint_auth_method === 'string' ? parsed.token_endpoint_auth_method : request.tokenEndpointAuthMethod;
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) throw new Error('Unsupported token endpoint authentication method');
    return { clientId, clientSecret, tokenEndpointAuthMethod: method };
  }
}
