/**
 * Credential shapes shared by the provider adapter contract and the auth
 * contract. Extracted into their own module so `auth.ts` and `provider.ts` can
 * both reference them without importing each other (no cycle).
 */

export type CredKind = 'api-key' | 'oauth' | 'aws';

export interface ResolvedCreds {
  apiKey?: string;
  /** Bearer token auth used by OAuth-backed Anthropic/Claude Code flows. */
  authToken?: string;
  baseURL?: string;
  extraHeaders?: Record<string, string>;
  /** Optional provider-specific fetch implementation (proxy/retry/auth parity). */
  fetch?: typeof fetch;
  aws?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    region?: string;
  };
  /** OAuth-specific scratch (accountId for ChatGPT, editor opts for Copilot). */
  extra?: Record<string, unknown>;
}

/**
 * Structural view of a stored provider instance row. A subset of the store's
 * `ProviderConfig`, declared here so the SDK contract stays a leaf (no
 * dependency on `@mcp/store`). The real `ProviderConfig` satisfies it.
 */
export interface ProviderConfigLike {
  id: string;
  kind: string;
  name?: string;
  base_url?: string | null;
  api_key?: string | null;
  extra?: Record<string, unknown> | null;
}
