/**
 * AWS Bedrock (SigV4) as a DECLARATIVE, BUNDLED first-party provider plugin.
 * Re-exports the canonical engine spec (single source of truth). First-party +
 * bundled → may carry host capabilities (bedrock wire, sdk:bedrock discovery,
 * aws-sigv4 auth). See provider-cloudflare for the full note.
 */
import { definePlugin } from '@mcp/plugin-sdk/define.js';
import { bedrockSpec } from '@mcp/provider-engine/specs/bedrock.js';

export default definePlugin({ providers: [bedrockSpec] });
