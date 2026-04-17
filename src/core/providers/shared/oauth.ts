import type { ResolvedCreds } from '../types.js';
import type { ProviderConfig } from '../../../store/provider-store.js';
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
import { extractAccountIdFromIdToken } from '../../coder/providers/chatgpt.js';
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
