import type { ProviderSpec } from '@mcp/provider-sdk';
import { defineProviderSpec } from '@mcp/provider-sdk';

/**
 * Declare the metadata for an LLM provider contributed by a plugin.
 *
 * This remains pure `ProviderSpec` DATA for Admin/config/pricing validation.
 * Executable provider ownership is added by exporting `providerAdapter` or
 * `providerAdapters` from the plugin bundle; the CLI records that separately
 * as `.app.json.providerRuntime`.
 */
export function contributeProvider(spec: ProviderSpec): ProviderSpec {
  return defineProviderSpec(spec);
}

export type { ProviderSpec } from '@mcp/provider-sdk';
