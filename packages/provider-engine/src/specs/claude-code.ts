import type { ProviderSpec } from '@mcp/provider-sdk';

// Inlined to keep the spec a leaf (no services/oauth import → no store cycle).
// Mirrors CLAUDE_CODE_BASE_URL in services/.../oauth/claude-code.ts, env override
// included so defaultBaseURL stays byte-identical to the definition.
const CLAUDE_CODE_BASE_URL = process.env.CLAUDE_CODE_API_BASE_URL ?? 'https://api.anthropic.com';

/**
 * Claude Code (OAuth) — the `anthropic` wire with `wireOpts.claudeCode`. The
 * adaptive model/effort/thinking resolution + system prefix blocks live in the
 * wire (wires/claude-code.ts), a verbatim lift of definitions/claude-code.ts.
 * OAuth creds (Bearer claude.ai inference OR managed console api-key) are produced
 * upstream by `resolveClaudeCodeCreds`. `test: sdk:claude-code` + live discovery
 * land in the OAuth-engine phase.
 */
export const claudeCodeSpec: ProviderSpec = {
  kind: 'claude-code',
  displayName: 'Claude Code (OAuth)',
  visual: { icon: 'Sparkles', fg: 'text-orange-400', bg: 'bg-orange-400/15' },
  credKind: 'oauth',
  envVars: [],
  defaultBaseURL: CLAUDE_CODE_BASE_URL,
  defaultModel: 'claude-sonnet-4-6',
  defaultModels: ['default', 'sonnet', 'sonnet[1m]', 'haiku', 'opus', 'opus[1m]', 'opus-4-6', 'opus-4-6[1m]'],
  pricing: {
    default: { inputPer1M: 0.0, outputPer1M: 0.0 },
    sonnet: { inputPer1M: 0.0, outputPer1M: 0.0 },
    'sonnet[1m]': { inputPer1M: 0.0, outputPer1M: 0.0 },
    haiku: { inputPer1M: 0.0, outputPer1M: 0.0 },
  },
  capabilities: { supportsThinking: true, supportsVision: true },
  wire: 'anthropic',
  wireOpts: { claudeCode: true },
  discovery: { from: 'sdk:claude-code' },
  test: { from: 'sdk:claude-code' },
  // Declarative OAuth (authorization-code + loopback + PKCE). The authorize host
  // depends on which scope set is requested (claude.ai inference vs console
  // managed-key). Values inlined from services/oauth/claude-code.ts (parity-tested).
  // refreshThresholdSec 300 (5min skew) applies on the claude_ai inference-bearer
  // branch; the dual-credential dispatch (bearer vs managed api_key), profile/roles
  // and system-prefix blocks are owned by the 'claude-code' hook.
  auth: {
    mode: 'oauth',
    flavor: 'authorization-code',
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
    refreshThresholdSec: 300,
    needs: { loopback: true, openBrowser: true, scheduledRefresh: true },
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrlByScope: [
      { whenScope: 'user:inference', url: 'https://claude.com/cai/oauth/authorize' },
      { whenScope: 'org:create_api_key', url: 'https://platform.claude.com/oauth/authorize' },
    ],
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    redirect: { port: 1456, path: '/callback' },
    authorizeParams: { code: 'true' },
    hooks: 'claude-code',
  },
};

export const CLAUDE_CODE_SPECS: ProviderSpec[] = [claudeCodeSpec];
