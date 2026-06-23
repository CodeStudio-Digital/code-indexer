import type { ProviderDefinition } from '@mcp/provider-sdk';

/**
 * Declare an LLM provider contributed by a plugin.
 *
 * Identity helper over the `@mcp/provider-sdk` contract — a contributed
 * provider IS a `ProviderDefinition`, the exact shape built-ins use, so once
 * registered it dispatches identically (CLI wizard, admin picker, model
 * discovery, cost lookup, both factories, the `/test` badge).
 *
 * Unlike a tool (which runs sandboxed in the plugin worker), a provider's
 * adapter runs IN-PROCESS on the agent's hot path and handles real
 * credentials. The provider-host loader therefore only registers providers
 * from bundles that pass install-time trust verification (first-party /
 * pinned-key signed). See the loader for the trust gate.
 */
export function contributeProvider(provider: ProviderDefinition): ProviderDefinition {
  return provider;
}

export type { ProviderDefinition } from '@mcp/provider-sdk';
