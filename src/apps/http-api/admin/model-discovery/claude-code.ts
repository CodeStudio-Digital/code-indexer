/**
 * Claude Code model discovery. Mirrors Anthropic /v1/models, but credentials
 * may be Claude.ai OAuth bearer auth instead of x-api-key.
 */
import type {
  ProviderStore,
  ProviderConfig,
  UpsertModelInput,
} from '../../../../store/provider-store.js';
import { CLAUDE_CODE_SEED_MODELS } from '../../../../core/providers/definitions/claude-code.js';
import { resolveClaudeCodeCreds } from '../../../../core/providers/shared/oauth.js';
import {
  fetchClaudeCodeModels,
  resolveClaudeCodeModel,
  type ClaudeCodeAccountInfo,
  type ClaudeCodeProfileInfo,
} from '../../../../core/services/oauth/claude-code.js';

export async function discoverClaudeCode(
  _store: ProviderStore,
  cfg: ProviderConfig,
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

  return CLAUDE_CODE_SEED_MODELS.map((model) => {
    const resolved = resolveClaudeCodeModel(model.model_id, accountInfo, {
      includeOAuth: !!creds.authToken,
      thinking: true,
    });
    const liveNote = liveIds.size > 0 && !liveIds.has(resolved.apiModel)
      ? ' Not returned by live /v1/models?beta=true.'
      : '';
    return {
      ...model,
      description: `${model.description} Resolved: ${resolved.requestedModel} -> ${resolved.apiModel}. Betas: ${resolved.betas.join(',')}.${liveNote}`,
      default_max_tokens: resolved.maxTokens,
      source: 'live' as const,
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
  };
}
