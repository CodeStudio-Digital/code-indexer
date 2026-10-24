import type { ProviderDefinition } from '@mcp/provider-sdk';
import { BUILTIN_SPECS } from '@mcp/provider-engine/specs/index.js';

type ProviderSeedDefinition = Pick<
  ProviderDefinition,
  'kind' | 'displayName' | 'envVars' | 'defaultBaseURL' | 'capabilities'
>;

let resolveDefinitions: () => readonly ProviderSeedDefinition[] = () => BUILTIN_SPECS;

/** The runtime registry supplies plugin-aware metadata after it is loaded. */
export function setProviderSeedDefinitionsResolver(
  resolver: () => readonly ProviderSeedDefinition[],
): void {
  resolveDefinitions = resolver;
}

/** Database initialization only needs metadata; it never constructs adapters. */
export function listProviderSeedDefinitions(): readonly ProviderSeedDefinition[] {
  return resolveDefinitions();
}
