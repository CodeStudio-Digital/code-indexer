export interface DcrRequest {
  clientName: string;
  redirectUris: readonly string[];
  scopes: readonly string[];
  grantTypes: readonly string[];
  tokenEndpointAuthMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
}

export interface DcrResponse {
  clientId: string;
  clientSecret: string | null;
}

/**
 * Registers our app as a client with a remote Authorization Server (RFC 7591).
 * Returns null client_secret for public clients (PKCE only).
 */
export interface DcrClient {
  register(registrationEndpoint: string, request: DcrRequest): Promise<DcrResponse>;
}
