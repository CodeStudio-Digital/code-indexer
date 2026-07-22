import type { ProviderSpec } from '@mcp/provider-sdk';

// Inlined to keep the spec a leaf (no services/oauth import → no store cycle).
// Mirrors CLAUDE_CODE_BASE_URL in services/.../oauth/claude-code.ts, env override
// included so defaultBaseURL stays byte-identical to the definition.
const CLAUDE_CODE_BASE_URL = process.env.CLAUDE_CODE_API_BASE_URL ?? 'https://api.anthropic.com';

// Effort levels mirror Claude Code's `getClaudeCodeEffort()`. Only adaptive
// models accept them; callers still clamp against the resolved model family.
const CLAUDE_CODE_EFFORT_LEVELS_XHIGH = ['low', 'medium', 'high', 'xhigh'] as const;
const CLAUDE_CODE_EFFORT_LEVELS_BASE = ['low', 'medium', 'high'] as const;

export const CLAUDE_CODE_SEED_MODELS = [
  {
    model_id: 'fable',
    name: 'Fable 5',
    display_name: 'Fable 5',
    description: 'Fable 5 - Claude Code most capable model for the hardest long-running tasks; requires usage credits and one-time consent.',
    context_window: 1_000_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_XHIGH],
  },
  {
    model_id: 'sonnet',
    name: 'Sonnet 5',
    display_name: 'Sonnet 5',
    description: 'Sonnet 5 - Claude Code current everyday model with native 1M context.',
    context_window: 1_000_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_XHIGH],
  },
  {
    model_id: 'sonnet-4-6',
    name: 'Sonnet 4.6',
    display_name: 'Sonnet 4.6',
    description: 'Sonnet 4.6 - previous-generation Sonnet with 200K context.',
    context_window: 200_000,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_BASE],
  },
  {
    model_id: 'haiku',
    name: 'Haiku 4.5',
    display_name: 'Haiku 4.5',
    description: 'Haiku 4.5 - Fastest for quick answers.',
    context_window: 200_000,
    default_max_tokens: 32_000,
    can_reason: false,
    supports_attachments: true,
    default_reasoning_level: null,
    supported_reasoning_levels: null,
  },
  {
    model_id: 'opus',
    name: 'Opus 4.8',
    display_name: 'Opus 4.8',
    description:
      'Opus 4.8 - Claude Code current top-tier reasoning model with native 1M context.',
    context_window: 1_000_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_XHIGH],
  },
  {
    model_id: 'opus-4-7',
    name: 'Opus 4.7',
    display_name: 'Opus 4.7',
    description: 'Opus 4.7 - previous-generation Opus with native 1M context.',
    context_window: 1_000_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'xhigh',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_XHIGH],
  },
  {
    model_id: 'opus-4-6',
    name: 'Opus 4.6',
    display_name: 'Opus 4.6',
    description:
      'Opus 4.6 - previous-generation Opus with adaptive thinking and effort support.',
    context_window: 200_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_BASE],
  },
] as const;

/**
 * Claude Code (OAuth) — the `anthropic` wire with `wireOpts.claudeCode`. The
 * adaptive model/effort/thinking resolution + system prefix blocks live in the
 * wire (wires/claude-code.ts).
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
  defaultModel: 'fable',
  defaultModels: CLAUDE_CODE_SEED_MODELS.map((m) => m.model_id),
  pricing: {
    fable: { inputPer1M: 0.0, outputPer1M: 0.0 },
    sonnet: { inputPer1M: 0.0, outputPer1M: 0.0 },
    haiku: { inputPer1M: 0.0, outputPer1M: 0.0 },
  },
  capabilities: { supportsThinking: true, supportsVision: true, fileInput: 'pdf-only' },
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
