/**
 * ChatGPT / Codex (OAuth) as a DECLARATIVE, BUNDLED first-party provider plugin.
 * Re-exports the canonical engine spec (single source of truth). First-party +
 * bundled → may carry host capabilities (auth.hooks 'chatgpt', codex wire,
 * chatgpt-models discovery). See provider-cloudflare for the full note.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { chatgptSpec } from '@mcp/provider-engine/specs/chatgpt.js';

export default definePlugin({ providers: [chatgptSpec] });
