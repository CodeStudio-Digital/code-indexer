/**
 * Z.AI / GLM as a DECLARATIVE, BUNDLED provider plugin — the reference for adding
 * a provider as pure DATA through the plugin SDK.
 *
 * First-party bundled plugins re-export the CANONICAL `ProviderSpec` from
 * `@mcp/provider-engine` (single source of truth — the same object the engine
 * equivalence tests validate). esbuild tree-shakes the import down to the spec
 * data object; NO engine runtime code is pulled in. The CLI `build` writes the
 * spec verbatim into `.app.json`; the host turns it into a runtime definition via
 * `buildProviderDefinition` (the engine), so NO plugin code runs in-process. The
 * `wireOpts.modelModes` (`::coding`/`::general` baseURL routing + `ZAI_BASE_URL`
 * env override) express everything the old hand-written adapter did, as data.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { zaiSpec } from '@mcp/provider-engine/specs/openai-compat.js';

export default definePlugin({ providers: [zaiSpec] });
