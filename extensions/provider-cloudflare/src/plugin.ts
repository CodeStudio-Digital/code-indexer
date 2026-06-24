/**
 * Cloudflare Workers AI as a DECLARATIVE, BUNDLED provider plugin.
 *
 * First-party bundled plugins re-export the CANONICAL `ProviderSpec` from
 * `@mcp/provider-engine` (single source of truth — the same object the engine
 * equivalence tests validate). esbuild tree-shakes the import down to the spec
 * data object; NO engine runtime code is pulled in. The CLI `build` writes the
 * spec verbatim into `.app.json`; the host turns it into a runtime definition
 * via `buildProviderDefinition`, so NO plugin code runs in-process.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { cloudflareSpec } from '@mcp/provider-engine/specs/openai-compat.js';

export default definePlugin({ providers: [cloudflareSpec] });
