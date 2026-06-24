/**
 * OpenRouter as a DECLARATIVE, BUNDLED provider plugin. Re-exports the canonical
 * `ProviderSpec` from `@mcp/provider-engine` (single source of truth); esbuild
 * tree-shakes to just the spec data. See provider-cloudflare for the full note.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { openrouterSpec } from '@mcp/provider-engine/specs/openai-compat.js';

export default definePlugin({ providers: [openrouterSpec] });
