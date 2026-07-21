import type { ProviderDefinition, ResolvedCreds } from '../types.js';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
// Leaf engine primitive (RFC 6749 refresh + rotation-tolerant fold). One-way
// edge: services already depends on @mcp/provider-engine; token.ts imports only
// @mcp/provider-sdk types + node, so no cycle.
import { refreshTokenGrant, applyRefresh } from '@mcp/provider-engine/oauth/token.js';
import {
  refreshIfExpired as refreshCopilotToken,
  copilotHeaders,
  getStoredCopilotOpts,
} from '../../services/oauth/copilot.js';
import {
  refreshIfExpired as refreshOpenAIToken,
  CHATGPT_CODEX_BASE_URL,
} from '../../services/oauth/openai.js';
import {
  refreshIfExpired as refreshGoogleToken,
} from '../../services/oauth/google.js';
import {
  refreshIfExpired as refreshClaudeCodeToken,
  CLAUDE_CODE_BASE_URL,
  CLAUDE_CODE_OAUTH_BETA,
  claudeCodeFetch,
  createClaudeCodeFetchWithRetry,
  getClaudeCodeRequestMetadata,
  getClaudeCodeRuntimeHeaders,
} from '../../services/oauth/claude-code.js';
import { extractAccountIdFromIdToken } from '@mcp/code-agent/providers/chatgpt.js';
import { getStore } from './store.js';

/**
 * Refresh the 25-min Copilot token (if expired) and return creds shaped
 * for the OpenAI-compat adapter. Falls back to the stored api_key mirror
 * if the refresh fails — still valid for a few seconds and the caller
 * will retry on 401 next request anyway.
 *
 * Consolidates the duplication in:
 *   - indexer/providers/factory.ts::buildCopilotAgentProvider
 *   - coder/providers/factory.ts (copilot case)
 *
 * The api_key column on `providers` is kept in sync with the freshly minted
 * OAuth token (mirror writeback). Required because the fallback path reads
 * `cfg.api_key` when refresh fails — without this, the fallback would serve
 * a token from the first session forever.
 */
export async function resolveCopilotCreds(cfg: ProviderConfig): Promise<ResolvedCreds> {
  const store = getStore();
  if (!store) throw new Error('Copilot requires the ProviderStore');

  let token = cfg.api_key ?? '';
  try {
    const fresh = await refreshCopilotToken(store, cfg.id);
    if (fresh && fresh !== cfg.api_key) {
      token = fresh;
      store.upsertProvider({ ...cfg, api_key: fresh });
    } else if (fresh) {
      token = fresh;
    }
  } catch (e) {
    console.warn(`[copilot] refresh failed: ${(e as Error).message}`);
  }

  const opts = getStoredCopilotOpts(store, cfg.id);
  const tok = store.getOAuth(cfg.id);
  const extra = (tok?.extra ?? {}) as { endpoints?: Record<string, string> };
  const baseURL = (
    extra.endpoints?.api ??
    cfg.base_url ??
    'https://api.githubcopilot.com'
  ).replace(/\/$/, '');

  // SDK owns Authorization via apiKey; strip ours to avoid duplication.
  const headers = copilotHeaders(token, opts);
  delete (headers as { Authorization?: string }).Authorization;

  return { apiKey: token, baseURL, extraHeaders: headers };
}

/**
 * Refresh the ChatGPT / Codex token and extract the chatgpt_account_id
 * from the stored id_token JWT. Account id is required by the Responses
 * API header (chatgpt-account-id).
 */
export async function resolveChatGPTCreds(cfg: ProviderConfig): Promise<ResolvedCreds> {
  const store = getStore();
  if (!store) throw new Error('ChatGPT requires the ProviderStore');

  let token = cfg.api_key ?? '';
  try {
    const fresh = await refreshOpenAIToken(store, cfg.id);
    if (fresh && fresh !== cfg.api_key) {
      token = fresh;
      store.upsertProvider({ ...cfg, api_key: fresh });
    } else if (fresh) {
      token = fresh;
    }
  } catch (e) {
    console.warn(`[chatgpt] refresh failed: ${(e as Error).message}`);
  }

  const tok = store.getOAuth(cfg.id);
  const extra = (tok?.extra ?? {}) as { id_token?: string };
  const accountId = extractAccountIdFromIdToken(extra.id_token ?? null);
  const baseURL = (cfg.base_url ?? CHATGPT_CODEX_BASE_URL).replace(/\/$/, '');

  return {
    apiKey: token,
    baseURL,
    extra: { accountId },
  };
}

/**
 * Refresh the Google OAuth access token and return it as apiKey so the
 * Gemini providers can use it via Bearer header.
 */
export async function resolveGoogleOAuthCreds(cfg: ProviderConfig): Promise<ResolvedCreds> {
  const store = getStore();
  if (!store) throw new Error('Google OAuth requires the ProviderStore');

  let token = cfg.api_key ?? '';
  try {
    const fresh = await refreshGoogleToken(store, cfg.id);
    if (fresh && fresh !== cfg.api_key) {
      token = fresh;
      store.upsertProvider({ ...cfg, api_key: fresh });
    } else if (fresh) {
      token = fresh;
    }
  } catch (e) {
    console.warn(`[google-oauth] refresh failed: ${(e as Error).message}`);
  }

  const tok = store.getOAuth(cfg.id);
  const extra = (tok?.extra ?? {}) as { projectId?: string };

  return {
    apiKey: token,
    extra: {
      refreshToken: tok?.refresh_token,
      projectId: extra.projectId,
    },
  };
}

/**
 * Resolve Claude Code OAuth credentials. Claude.ai accounts with
 * `user:inference` use Bearer auth plus the OAuth beta header; console-only
 * authorizations fall back to the managed API key that Claude Code creates.
 */
export async function resolveClaudeCodeCreds(cfg: ProviderConfig): Promise<ResolvedCreds> {
  const store = getStore();
  if (!store) throw new Error('Claude Code requires the ProviderStore');
  const runtimeHeaders = getClaudeCodeRuntimeHeaders(store, cfg.id);
  const metadata = getClaudeCodeRequestMetadata(store, cfg.id);

  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) {
    return {
      authToken: envToken,
      baseURL: (cfg.base_url ?? CLAUDE_CODE_BASE_URL).replace(/\/$/, ''),
      extraHeaders: {
        ...runtimeHeaders,
        'anthropic-beta': CLAUDE_CODE_OAUTH_BETA,
      },
      fetch: claudeCodeFetch,
      extra: {
        authType: 'env_oauth',
        subscriptionType: process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE ?? null,
        rateLimitTier: process.env.CLAUDE_CODE_RATE_LIMIT_TIER ?? null,
        metadata,
      },
    };
  }

  const tok = store.getOAuth(cfg.id);
  const scope = tok?.scope ?? '';
  const authType = tok?.extra?.auth_type;
  const usesClaudeAi =
    authType === 'claude_ai' ||
    scope.split(/\s+/).filter(Boolean).includes('user:inference');

  const baseURL = (cfg.base_url ?? CLAUDE_CODE_BASE_URL).replace(/\/$/, '');
  if (usesClaudeAi) {
    // Source-of-truth for the OAuth Bearer is oauth_tokens.access_token.
    // cfg.api_key is a mirror that older console-flow connections may have
    // contaminated with an sk-ant-* API key; trust oauth_tokens first.
    let token = tok?.access_token ?? cfg.api_key ?? '';
    try {
      const fresh = await refreshClaudeCodeToken(store, cfg.id);
      if (fresh) {
        token = fresh;
        if (fresh !== cfg.api_key) {
          store.upsertProvider({ ...cfg, api_key: fresh });
        }
      }
    } catch (e) {
      const err = e as Error;
      console.error(
        `[claude-code] refresh FAILED for provider=${cfg.id} expires_at=${tok?.expires_at ?? 'null'} class=${err.constructor.name}: ${err.message}`,
      );
    }
    if (!token) throw new Error('no Claude Code access token stored - re-connect');

    return {
      authToken: token,
      baseURL,
      extraHeaders: {
        ...runtimeHeaders,
        'anthropic-beta': CLAUDE_CODE_OAUTH_BETA,
      },
      fetch: createClaudeCodeFetchWithRetry(store, cfg.id),
      extra: {
        authType: 'claude_ai',
        profile: tok?.extra?.profile,
        profileInfo: tok?.extra?.profile_info,
        roles: tok?.extra?.roles,
        metadata,
      },
    };
  }

  const storedApiKey = tok?.extra?.api_key as string | undefined;
  const apiKey = cfg.api_key ?? storedApiKey ?? '';
  if (!apiKey) throw new Error('no Claude Code API key stored - re-connect');
  return {
    apiKey,
    baseURL,
    extraHeaders: runtimeHeaders,
    fetch: claudeCodeFetch,
    extra: {
      authType: 'api_key',
      profile: tok?.extra?.profile,
      roles: tok?.extra?.roles,
      metadata,
    },
  };
}

/**
 * Pure-declarative RFC 6749 refresh for a HOOKLESS OAuth provider (a third-party
 * authorization-code/device-code plugin that sets only `spec.auth.tokenUrl` +
 * `clientId`). Refreshes near expiry using the engine primitives, persists the
 * rotated token (rotation-tolerant via {@link applyRefresh}) + mirrors api_key,
 * and returns Bearer creds. The 4 first-party OAuth connectors DON'T use this — they
 * delegate to their hardened `resolve*Creds` (see {@link runOAuthRefresh}).
 */
async function resolveGenericOAuthCreds(
  def: ProviderDefinition,
  cfg: ProviderConfig,
): Promise<ResolvedCreds> {
  const store = getStore();
  if (!store) throw new Error(`OAuth provider '${def.kind}' requires the ProviderStore`);
  const auth = def.auth;
  const tok = store.getOAuth(cfg.id);
  let token = tok?.access_token ?? cfg.api_key ?? '';

  if (auth?.tokenUrl && tok?.refresh_token) {
    const thresholdMs = (auth.refreshThresholdSec ?? 60) * 1000;
    const needsRefresh = !tok.expires_at || tok.expires_at - Date.now() <= thresholdMs;
    if (needsRefresh) {
      try {
        const resp = await refreshTokenGrant(auth, {
          refreshToken: tok.refresh_token,
          scope: auth.scopes?.length ? auth.scopes.join(' ') : undefined,
        });
        const next = applyRefresh(cfg.id, tok, resp);
        store.setOAuth(next);
        store.upsertProvider({ ...cfg, api_key: next.access_token });
        token = next.access_token;
      } catch (e) {
        console.warn(`[${def.kind}] generic OAuth refresh failed: ${(e as Error).message}`);
      }
    }
  }

  return {
    apiKey: token || undefined,
    baseURL: cfg.base_url ?? def.defaultBaseURL,
    extra: cfg.extra,
  };
}

/**
 * Data-driven OAuth credential resolution, dispatched by `spec.auth.hooks`. For
 * the 4 first-party OAuth connectors this is EXACTLY the legacy per-kind dispatch
 * (`hooks` === kind), delegating to the same hardened `resolve*Creds` so every
 * lockout defense (kimi tombstone/race, copilot PAT inversion, claude-code
 * dual-cred) is preserved verbatim. A hookless provider falls through to the
 * pure-declarative RFC path. This is the seam the resolver uses behind
 * `MCP_GENERIC_OAUTH`; the legacy switch stays the default until per-kind E2E.
 */
export function runOAuthRefresh(
  def: ProviderDefinition,
  cfg: ProviderConfig,
): Promise<ResolvedCreds> {
  switch (def.auth?.hooks) {
    case 'copilot':
      return resolveCopilotCreds(cfg);
    case 'chatgpt':
      return resolveChatGPTCreds(cfg);
    case 'google-oauth':
      return resolveGoogleOAuthCreds(cfg);
    case 'claude-code':
      return resolveClaudeCodeCreds(cfg);
    default:
      return resolveGenericOAuthCreds(def, cfg);
  }
}
