/**
 * Sakana AI Fugu as a DECLARATIVE, BUNDLED provider plugin.
 *
 * First-party bundled plugins re-export the CANONICAL `ProviderSpec` from
 * `@mcp/provider-engine` (single source of truth — the same object the engine
 * equivalence/drift tests validate). esbuild tree-shakes the import down to the
 * spec data object; NO engine runtime code is pulled in. The CLI `build` writes
 * the spec verbatim into `.app.json`; the host turns it into a runtime definition
 * via `buildProviderDefinition` (the engine), so NO plugin code runs in-process.
 *
 * Fugu speaks the OpenAI API (chat/completions + /models). Its reasoning-effort
 * control (`reasoning_effort: high|xhigh|max`) is forwarded per-request by the
 * `vendor:'fugu'` branch in the openai-compat adapter — a host capability, which
 * is why Fugu ships as a first-party bundled provider rather than pure data.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { fuguSpec } from '@mcp/provider-engine/specs/openai-compat.js';

export default definePlugin({ providers: [fuguSpec] });
