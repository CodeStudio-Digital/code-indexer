/**
 * Google / Gemini (OAuth) as a DECLARATIVE, BUNDLED first-party provider plugin.
 * Re-exports the canonical engine spec (single source of truth). First-party +
 * bundled → may carry host capabilities (auth.hooks 'google-oauth', geminiOAuth
 * wire flag, sdk:google-oauth discovery). See provider-cloudflare for the note.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { googleOAuthSpec } from '@mcp/provider-engine/specs/google-oauth.js';

export default definePlugin({ providers: [googleOAuthSpec] });
