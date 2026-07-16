import type { ProviderSpec, ResolvedCreds, ProviderDefinition, CreateCoderOpts } from '@mcp/provider-sdk';
import { AnthropicChatProvider } from '@mcp/code-agent/providers/anthropic.js';
import {
  getClaudeCodeSystemPrefixBlocks,
  resolveClaudeCodeModel,
  type ClaudeCodeAccountInfo,
  type ClaudeCodeEffort,
  type ClaudeCodeProfileInfo,
} from '../wire-helpers/claude-code.js';

type WireParts = Pick<
  ProviderDefinition,
  'createCoder' | 'fetchModels' | 'testConnection'
>;

const CLAUDE_CODE_VALID_EFFORTS: readonly ClaudeCodeEffort[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * Read the per-model `default_reasoning_level` set in the admin UI. Returns
 * `undefined` (not `null`) on miss so the resolver falls back to the env var
 * then the model-family default. Best-effort.
 */
function readClaudeCodeEffortForModel(
  opts: CreateCoderOpts | undefined,
  modelAlias: string,
): ClaudeCodeEffort | 'auto' | null | undefined {
  const row = opts?.providerModels?.find((m) => m.model_id === modelAlias);
  const stored = row?.default_reasoning_level;
  if (!stored) return undefined;
  if (stored === 'auto') return 'auto';
  return CLAUDE_CODE_VALID_EFFORTS.includes(stored as ClaudeCodeEffort)
    ? (stored as ClaudeCodeEffort)
    : undefined;
}

function claudeCodeMessageHeaders(creds: {
  authToken?: string;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const headers = { ...creds.extraHeaders };
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'anthropic-beta') delete headers[key];
  }
  return headers;
}

function claudeCodeAccountInfo(creds: { extra?: Record<string, unknown> }): ClaudeCodeAccountInfo {
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

/**
 * Claude Code branch of the `anthropic` wire (`wireOpts.claudeCode`). Routes the
 * resolved OAuth creds (Bearer claude.ai inference OR managed console api-key)
 * through `resolveClaudeCodeModel` — the adaptive model/effort/thinking resolver
 * — with the per-request `resolveModel` hook the agent calls each turn.
 */
export function buildClaudeCode(_spec: ProviderSpec): WireParts {
  return {
    createCoder: (creds: ResolvedCreds, model?: string, opts?: CreateCoderOpts) => {
      const accountInfo = claudeCodeAccountInfo(creds);
      const initial = resolveClaudeCodeModel(model ?? 'default', accountInfo, {
        includeOAuth: !!creds.authToken,
        thinking: true,
        effort: readClaudeCodeEffortForModel(opts, model ?? 'default'),
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
            effort: readClaudeCodeEffortForModel(opts, selectedModel),
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
  };
}
