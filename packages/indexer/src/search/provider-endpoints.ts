/**
 * Resolve an OpenAI-compatible endpoint from an admin-configured provider row.
 *
 * Reranker and embedding configs can opt into `kind: 'provider'`, which stores
 * only `{ providerId, model }` and reuses the credentials the user already
 * entered for a chat provider (OpenRouter, OpenAI, …) — no duplicated API key.
 * Both factories (`createReranker`, `createEmbeddingService`) call
 * `resolveProviderEndpoint()` to turn a provider row into `{ baseURL, apiKey }`,
 * then append `/rerank` or `/embeddings`.
 *
 * Only OpenAI-compatible wires are supported: their effective base URL is
 * `base_url ?? defaultBaseURL` and both `/embeddings` (OpenAI shape) and, for
 * OpenRouter, `/rerank` (Cohere shape) hang off it. Anthropic/Gemini/Bedrock
 * use different wire formats and resolve to `null` here.
 */

/** Default base URL per OpenAI-compatible provider kind (mirrors the specs in
 *  `@mcp/provider-engine/specs/openai-compat`). Used when a provider row's
 *  `base_url` is null. */
export const OPENAI_COMPAT_BASE_URL: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  zai: 'https://api.z.ai/api/paas/v4',
};

/** Provider kinds that expose an OpenAI-compatible base URL we can append
 *  `/embeddings` (and, for OpenRouter, `/rerank`) to. */
export const OPENAI_COMPAT_KINDS = Object.keys(OPENAI_COMPAT_BASE_URL);

/** Minimal structural view of a `provider_configs` row. Declared locally so the
 *  indexer stays decoupled from `@mcp/store`. */
export interface ProviderCredsLike {
  kind: string;
  base_url: string | null;
  api_key: string | null;
}

/**
 * Turn a provider row into a usable `{ baseURL, apiKey }`, or `null` when the
 * provider has no key or isn't an OpenAI-compatible kind (so the factory falls
 * through to the next backend / Null service). `baseURL` has its trailing slash
 * stripped so callers can append `/rerank` or `/embeddings` directly.
 */
export function resolveProviderEndpoint(
  prov: ProviderCredsLike | null | undefined,
): { baseURL: string; apiKey: string } | null {
  if (!prov?.api_key) return null;
  const base = (prov.base_url ?? OPENAI_COMPAT_BASE_URL[prov.kind] ?? '').replace(/\/+$/, '');
  if (!base) return null;
  return { baseURL: base, apiKey: prov.api_key };
}
