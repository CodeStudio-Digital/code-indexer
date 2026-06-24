/**
 * Claude Code (OAuth) as a DECLARATIVE, BUNDLED first-party provider plugin.
 * Re-exports the canonical engine spec (single source of truth). First-party +
 * bundled → may carry host capabilities (auth.hooks 'claude-code', dual-cred,
 * sdk:claude-code discovery/test). See provider-cloudflare for the full note.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { claudeCodeSpec } from '@mcp/provider-engine/specs/claude-code.js';

export default definePlugin({ providers: [claudeCodeSpec] });
