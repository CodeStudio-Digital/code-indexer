import type { ProviderSpec } from '@mcp/provider-sdk';
import { defineProviderSpec } from '@mcp/provider-sdk';

/**
 * Declare an LLM provider contributed by a plugin, as a declarative
 * `@mcp/provider-sdk` `ProviderSpec` — PURE DATA (no adapter functions).
 *
 * Identity helper (alias of `defineProviderSpec`). The CLI `build` writes the
 * spec verbatim into `.app.json`; the host turns it into a runtime definition
 * via `buildProviderDefinition` (the engine, the same path built-ins take), so
 * NO plugin code runs in-process. A plugin may only use the 6 known wires +
 * RFC-declarative auth; a new wire/auth is a first-party engine change.
 */
export function contributeProvider(spec: ProviderSpec): ProviderSpec {
  return defineProviderSpec(spec);
}

export type { ProviderSpec } from '@mcp/provider-sdk';
