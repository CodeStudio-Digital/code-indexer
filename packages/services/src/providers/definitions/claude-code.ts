import { defineProvider } from '../types.js';
import { getStore } from '../shared/store.js';
import { AnthropicProvider } from '@mcp/indexer/indexer/providers/anthropic.js';
import { AnthropicChatProvider } from '@mcp/code-agent/providers/anthropic.js';
import {
  CLAUDE_CODE_BASE_URL,
  fetchClaudeCodeModels,
  getClaudeCodeSystemPrefixBlocks,
  resolveClaudeCodeModel,
  type ClaudeCodeAccountInfo,
  type ClaudeCodeEffort,
  type ClaudeCodeProfileInfo,
} from '../../services/oauth/claude-code.js';

// Effort levels mirror Claude Code's `getClaudeCodeEffort()`. Only adaptive
// models (opus 4.6/4.7, sonnet 4.6) accept it; haiku ignores. `xhigh` is
// upstream-restricted to opus 4.7 — anything else is downgraded to `high`.
const CLAUDE_CODE_EFFORT_LEVELS_47 = ['low', 'medium', 'high', 'xhigh'] as const;
const CLAUDE_CODE_EFFORT_LEVELS_BASE = ['low', 'medium', 'high'] as const;

export const CLAUDE_CODE_SEED_MODELS = [
  {
    model_id: 'default',
    name: 'Default (recommended)',
    display_name: 'Default (recommended)',
    description: 'Claude Code default: Opus 4.7 with 1M context on Max/Team Max, otherwise Sonnet 4.6.',
    context_window: 1_000_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    // The `default` alias resolves at runtime — admin UI gives the user one
    // effort knob; the resolver clamps to `high` if the resolved model is
    // not opus 4.7.
    default_reasoning_level: 'xhigh',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_47],
  },
  {
    model_id: 'sonnet',
    name: 'Sonnet',
    display_name: 'Sonnet',
    description: 'Sonnet 4.6 - Best for everyday tasks.',
    context_window: 200_000,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_BASE],
  },
  {
    model_id: 'sonnet[1m]',
    name: 'Sonnet (1M context)',
    display_name: 'Sonnet (1M context)',
    description: 'Sonnet 4.6 with 1M context - billed as extra usage by Claude Code.',
    context_window: 1_000_000,
    default_max_tokens: 32_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_BASE],
  },
  {
    model_id: 'haiku',
    name: 'Haiku',
    display_name: 'Haiku',
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
    name: 'Opus',
    display_name: 'Opus',
    description:
      'Opus 4.7 - Top-tier reasoning. Higher quota cost; available to all Claude.ai inference scopes but consumes Max session tokens fastest.',
    context_window: 200_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'xhigh',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_47],
  },
  {
    model_id: 'opus[1m]',
    name: 'Opus (1M context)',
    display_name: 'Opus (1M context)',
    description:
      'Opus 4.7 with 1M context - billed as extra usage by Claude Code; default for Max/Team Max accounts.',
    context_window: 1_000_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'xhigh',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_47],
  },
  {
    model_id: 'opus-4-6',
    name: 'Opus 4.6',
    display_name: 'Opus 4.6',
    description:
      'Opus 4.6 - previous-generation Opus. Same adaptive thinking and effort support, slightly faster than 4.7 on average.',
    context_window: 200_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_BASE],
  },
  {
    model_id: 'opus-4-6[1m]',
    name: 'Opus 4.6 (1M context)',
    display_name: 'Opus 4.6 (1M context)',
    description:
      'Opus 4.6 with 1M context - billed as extra usage by Claude Code.',
    context_window: 1_000_000,
    default_max_tokens: 64_000,
    can_reason: true,
    supports_attachments: true,
    default_reasoning_level: 'high',
    supported_reasoning_levels: [...CLAUDE_CODE_EFFORT_LEVELS_BASE],
  },
] as const;

/**
 * Claude Code OAuth. Runtime credentials are resolved as either:
 * - Claude.ai OAuth inference: Bearer token + `anthropic-beta: oauth-2025-04-20`
 * - Console OAuth fallback: managed API key created by Claude Code's endpoint
 */
export const claudeCode = defineProvider({
  kind: 'claude-code',
  displayName: 'Claude Code (OAuth)',
  visual: { icon: 'Sparkles', fg: 'text-orange-400', bg: 'bg-orange-400/15' },
  credKind: 'oauth',
  envVars: [],
  defaultBaseURL: CLAUDE_CODE_BASE_URL,
  defaultModel: 'claude-sonnet-4-6',
  defaultModels: CLAUDE_CODE_SEED_MODELS.map((m) => m.model_id),
  pricing: {
    default: { inputPer1M: 0.00, outputPer1M: 0.00 },
    sonnet: { inputPer1M: 0.00, outputPer1M: 0.00 },
    'sonnet[1m]': { inputPer1M: 0.00, outputPer1M: 0.00 },
    haiku: { inputPer1M: 0.00, outputPer1M: 0.00 },
  },
  capabilities: { supportsThinking: true, supportsVision: true },
  createIndexer: (creds, model) => {
    const resolved = resolveClaudeCodeModel(model ?? 'haiku', claudeCodeAccountInfo(creds), {
      includeOAuth: !!creds.authToken,
      thinking: false,
    });
    return new AnthropicProvider(creds.apiKey, resolved.apiModel, creds.baseURL, {
      authToken: creds.authToken,
      defaultHeaders: claudeCodeMessageHeaders(creds),
      defaultMetadata: creds.extra?.metadata as { user_id?: string } | undefined,
      defaultBetas: resolved.betas,
      defaultTemperature: 1,
      systemPrefixBlocks: creds.authToken ? getClaudeCodeSystemPrefixBlocks() : undefined,
      fetch: creds.fetch,
      name: 'claude-code',
      dangerouslyAllowBrowser: true,
      useBetaMessages: true,
      maxRetries: 0,
    });
  },
  createCoder: (creds, model, opts) => {
    const accountInfo = claudeCodeAccountInfo(creds);
    const providerId = opts?.providerId;
    const initial = resolveClaudeCodeModel(model ?? 'default', accountInfo, {
      includeOAuth: !!creds.authToken,
      thinking: true,
      effort: readClaudeCodeEffortForModel(providerId, model ?? 'default'),
    });
    return new AnthropicChatProvider({
      name: 'claude-code',
      apiKey: creds.apiKey,
      authToken: creds.authToken,
      baseURL: creds.baseURL,
      defaultHeaders: claudeCodeMessageHeaders(creds),
      defaultMetadata: creds.extra?.metadata as { user_id?: string } | undefined,
      defaultBetas: initial.betas,
      defaultTemperature: 1,
      systemPrefixBlocks: creds.authToken ? getClaudeCodeSystemPrefixBlocks() : undefined,
      fetch: creds.fetch,
      model: model ?? 'default',
      dangerouslyAllowBrowser: true,
      useBetaMessages: true,
      streamViaCreate: true,
      maxRetries: 0,
      resolveModel: (selectedModel, req) => {
        const resolved = resolveClaudeCodeModel(selectedModel, accountInfo, {
          includeOAuth: !!creds.authToken,
          thinking: true,
          hasTools: (req.tools?.length ?? 0) > 0,
          effort: readClaudeCodeEffortForModel(providerId, selectedModel),
        });
        return {
          apiModel: resolved.apiModel,
          requestedModel: resolved.requestedModel,
          displayModel: resolved.displayModel,
          maxTokens: resolved.maxTokens,
          betas: resolved.betas,
          thinking: resolved.thinking,
          outputConfig: resolved.outputConfig,
          effort: resolved.effort,
        };
      },
    });
  },
  testConnection: async ({ creds, config }) => {
    // `resolveClaudeCodeCreds` already refreshed/selected the right auth
    // (Bearer for claude.ai inference, managed api_key for console-only).
    await fetchClaudeCodeModels({
      baseURL: creds.baseURL ?? config.base_url,
      apiKey: creds.apiKey,
      authToken: creds.authToken,
      headers: creds.extraHeaders,
      fetch: creds.fetch,
    });
  },
});

const CLAUDE_CODE_VALID_EFFORTS: readonly ClaudeCodeEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
];

/**
 * Read the per-model `default_reasoning_level` set in the admin UI. Returns
 * `undefined` (not `null`) on miss so the resolver falls back to the env var
 * `CLAUDE_CODE_EFFORT_LEVEL` and then the model-family default.
 *
 * Best-effort: any store read failure is swallowed since the resolver still
 * works with no override.
 */
function readClaudeCodeEffortForModel(
  providerId: string | undefined,
  modelAlias: string,
): ClaudeCodeEffort | 'auto' | null | undefined {
  if (!providerId) return undefined;
  try {
    const store = getStore();
    if (!store) return undefined;
    const row = store.listModels(providerId).find((m) => m.model_id === modelAlias);
    const stored = row?.default_reasoning_level;
    if (!stored) return undefined;
    if (stored === 'auto') return 'auto';
    return CLAUDE_CODE_VALID_EFFORTS.includes(stored as ClaudeCodeEffort)
      ? (stored as ClaudeCodeEffort)
      : undefined;
  } catch {
    return undefined;
  }
}

function claudeCodeMessageHeaders(
  creds: { authToken?: string; extraHeaders?: Record<string, string> },
): Record<string, string> {
  const headers = { ...creds.extraHeaders };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'anthropic-beta') delete headers[key];
  }
  return headers;
}

function claudeCodeAccountInfo(
  creds: { extra?: Record<string, unknown> },
): ClaudeCodeAccountInfo {
  const profileInfo = creds.extra?.profileInfo as ClaudeCodeProfileInfo | undefined;
  const snakeProfileInfo = creds.extra?.profile_info as ClaudeCodeProfileInfo | undefined;
  return {
    subscriptionType:
      (creds.extra?.subscriptionType as string | null | undefined) ??
      (creds.extra?.subscription_type as string | null | undefined) ??
      profileInfo?.subscriptionType ??
      snakeProfileInfo?.subscriptionType ??
      null,
    rateLimitTier:
      (creds.extra?.rateLimitTier as string | null | undefined) ??
      (creds.extra?.rate_limit_tier as string | null | undefined) ??
      profileInfo?.rateLimitTier ??
      snakeProfileInfo?.rateLimitTier ??
      null,
  };
}
