/**
 * Kimi Code (OAuth) as a DECLARATIVE, BUNDLED first-party provider plugin.
 * Re-exports the canonical engine spec (single source of truth). First-party +
 * bundled → may carry host capabilities (auth.hooks 'kimi-code' device-code,
 * sdk:kimi-code discovery/test). See provider-cloudflare for the full note.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { kimiCodeSpec } from '@mcp/provider-engine/specs/kimi.js';

export default definePlugin({ providers: [kimiCodeSpec] });
