import { defineProvider } from '../types.js';
import { AnthropicProvider } from '../../indexer/providers/anthropic.js';
import { AnthropicChatProvider } from '../../coder/providers/anthropic.js';
import {
  CLAUDE_CODE_BASE_URL,
  getClaudeCodeSystemPrefixBlocks,
  resolveClaudeCodeModel,
  type ClaudeCodeAccountInfo,
  type ClaudeCodeProfileInfo,
} from '../../services/oauth/claude-code.js';

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
  credKind: 'oauth',
  envVars: [],
  defaultBaseURL: CLAUDE_CODE_BASE_URL,
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
  createCoder: (creds, model) => {
    const accountInfo = claudeCodeAccountInfo(creds);
    const initial = resolveClaudeCodeModel(model ?? 'default', accountInfo, {
      includeOAuth: !!creds.authToken,
      thinking: true,
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
      resolveModel: (selectedModel) => {
        const resolved = resolveClaudeCodeModel(selectedModel, accountInfo, {
          includeOAuth: !!creds.authToken,
          thinking: true,
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
});

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
