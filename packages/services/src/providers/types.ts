/**
 * Public types for the provider registry.
 *
 * The provider contract now lives in `@mcp/provider-sdk` (the leaf package that
 * breaks the old services↔code-agent/indexer cycle). This module re-exports it
 * verbatim so every existing `@mcp/services/providers/types.js` importer keeps
 * working. New code should import directly from `@mcp/provider-sdk`.
 */
export type {
  LLMProvider,
  ChatProvider,
  ChatRequest,
  ToolSpec,
  CredKind,
  ResolvedCreds,
  PricingEntry,
  ProviderCapabilities,
  DiscoveredModel,
  CreateCoderOpts,
  ProviderVisual,
  ProviderDefinition,
} from '@mcp/provider-sdk';

export { defineProvider, PROVIDER_SDK_VERSION } from '@mcp/provider-sdk';
