/**
 * Moonshot AI (api-key) as a DECLARATIVE, BUNDLED provider plugin. Re-exports the
 * canonical `ProviderSpec` from `@mcp/provider-engine` (single source of truth);
 * esbuild tree-shakes to just the spec data. See provider-cloudflare for the note.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { moonshotSpec } from '@mcp/provider-engine/specs/moonshot.js';

export default definePlugin({ providers: [moonshotSpec] });
