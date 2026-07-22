/**
 * Live model discovery for the `sdk:claude-code` format.
 *
 * Claude Code mirrors Anthropic `/v1/models`, but credentials may be Claude.ai
 * OAuth bearer auth instead of `x-api-key`. The discovery is *seed-driven*: the
 * `CLAUDE_CODE_SEED_MODELS` are always emitted (resolved through
 * `resolveClaudeCodeModel`), with the live `/v1/models?beta=true` list used only
 * to annotate descriptions — so a fetch failure never wipes the catalog.
 *
 * `spec` is part of the signature for uniformity but is unused (the base URL and
 * auth come entirely from the resolved OAuth creds / provider row).
 */
import type {
  ProviderStore,
  ProviderConfig,
  UpsertModelInput,
} from '@mcp/store/provider-store.js';
import type { ProviderSpec } from '@mcp/provider-sdk';
import { CLAUDE_CODE_SEED_MODELS } from '../specs/claude-code.js';
import { resolveClaudeCodeCreds } from '@mcp/services/providers/shared/oauth.js';
import {
  fetchClaudeCodeModels,
  resolveClaudeCodeModel,
  type ClaudeCodeAccountInfo,
  type ClaudeCodeProfileInfo,
} from '@mcp/services/services/oauth/claude-code.js';

export async function discoverClaudeCodeModels(
  _spec: ProviderSpec,
  cfg: ProviderConfig,
  _store: ProviderStore,
): Promise<UpsertModelInput[]> {
  const creds = await resolveClaudeCodeCreds(cfg);
  const liveModels = await fetchClaudeCodeModels({
    baseURL: creds.baseURL ?? cfg.base_url,
    apiKey: creds.apiKey,
    authToken: creds.authToken,
    headers: creds.extraHeaders,
    fetch: creds.fetch,
  }).catch(() => []);
  const liveIds = new Set(liveModels.map((model) => model.id));
  const accountInfo = claudeCodeAccountInfo(creds.extra);

  return CLAUDE_CODE_SEED_MODELS.map((model): UpsertModelInput => {
    const resolved = resolveClaudeCodeModel(model.model_id, accountInfo, {
      includeOAuth: !!creds.authToken,
      thinking: true,
    });
    const liveNote = liveIds.size > 0 && !liveIds.has(resolved.apiModel)
      ? ' Not returned by live /v1/models?beta=true.'
      : '';
    return {
      model_id: model.model_id,
      name: model.name,
      display_name: model.display_name,
      description: `${model.description} Resolved: ${resolved.requestedModel} -> ${resolved.apiModel}. Betas: ${resolved.betas.join(',')}.${liveNote}`,
      context_window: model.context_window,
      default_max_tokens: resolved.maxTokens,
      can_reason: model.can_reason,
      supports_attachments: model.supports_attachments,
      // Strip the `as const` readonly so the upsert input type accepts it.
      default_reasoning_level: model.default_reasoning_level,
      supported_reasoning_levels: model.supported_reasoning_levels
        ? [...model.supported_reasoning_levels]
        : null,
      source: 'live',
    };
  });
}

function claudeCodeAccountInfo(extra: Record<string, unknown> | undefined): ClaudeCodeAccountInfo {
  const profileInfo = extra?.profileInfo as ClaudeCodeProfileInfo | undefined;
  const snakeProfileInfo = extra?.profile_info as ClaudeCodeProfileInfo | undefined;
  return {
    subscriptionType:
      (extra?.subscriptionType as string | null | undefined) ??
      (extra?.subscription_type as string | null | undefined) ??
      profileInfo?.subscriptionType ??
      snakeProfileInfo?.subscriptionType ??
      null,
    rateLimitTier:
      (extra?.rateLimitTier as string | null | undefined) ??
      (extra?.rate_limit_tier as string | null | undefined) ??
      profileInfo?.rateLimitTier ??
      snakeProfileInfo?.rateLimitTier ??
      null,
    billingType:
      (extra?.billingType as string | null | undefined) ??
      (extra?.billing_type as string | null | undefined) ??
      profileInfo?.billingType ??
      snakeProfileInfo?.billingType ??
      null,
  };
}
