/**
 * GitHub Copilot (OAuth) as a DECLARATIVE, BUNDLED first-party provider plugin.
 * Re-exports the canonical `ProviderSpec` from `@mcp/provider-engine` (single
 * source of truth). Being first-party + bundled, its spec may carry host
 * capabilities (auth.hooks 'copilot', sdk:* discovery) — the install lane +
 * provider loader grant the first-party trust tier. See provider-cloudflare.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { copilotSpec } from '@mcp/provider-engine/specs/copilot.js';

export default definePlugin({ providers: [copilotSpec] });
