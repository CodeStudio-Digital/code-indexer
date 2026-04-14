import type { LLMProvider } from './base.js';
import type { ProviderName } from '../../../types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { DeepSeekProvider } from './deepseek.js';
import { GeminiProvider } from './gemini.js';
import { ZAIProvider } from './zai.js';
import { ChatGPTProvider } from './chatgpt.js';
import { ProviderStore, type ProviderConfig } from '../../../store/provider-store.js';
import { loadConfig } from '../../../utils/config.js';
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

let cachedStore: ProviderStore | null = null;
function getStore(): ProviderStore | null {
  if (cachedStore) return cachedStore;
  try {
    const cfg = loadConfig();
    cachedStore = new ProviderStore(cfg.dbPath);
    cachedStore.seedFromEnvIfEmpty();
    return cachedStore;
  } catch {
    return null;
  }
}

/**
 * Build a Copilot-flavored OpenAIProvider for the indexer. Copilot speaks
 * an OpenAI-compatible schema for chat completions but requires the full
 * editor header set (Editor-Version, Copilot-Integration-Id, ...) on
 * every request. The short-lived Copilot token is refreshed here before
 * instantiation — the indexer caller is always async.
 */
async function buildCopilotAgentProvider(
  store: ProviderStore,
  cfg: ProviderConfig,
  model?: string
): Promise<LLMProvider> {
  // Refresh the 25-min Copilot token. If it fails, fall through with the
  // existing api_key mirror — may still be valid for a few seconds.
  let token = cfg.api_key ?? '';
  try {
    const fresh = await refreshCopilotToken(store, cfg.id);
    if (fresh) token = fresh;
  } catch (e) {
    console.warn(`[copilot/indexer] refresh failed: ${(e as Error).message}`);
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
  return new OpenAIProvider(token, model ?? 'gpt-4o', baseURL, headers);
}

/**
 * Build a ChatGPT (Codex) indexer provider. Uses the Responses API via
 * src/agent/providers/chatgpt.ts and extracts the chatgpt_account_id
 * from the stored id_token JWT.
 */
async function buildChatGPTAgentProvider(
  store: ProviderStore,
  cfg: ProviderConfig,
  model?: string
): Promise<LLMProvider> {
  let token = cfg.api_key ?? '';
  try {
    const fresh = await refreshOpenAIToken(store, cfg.id);
    if (fresh) token = fresh;
  } catch (e) {
    console.warn(`[chatgpt/indexer] refresh failed: ${(e as Error).message}`);
  }
  const tok = store.getOAuth(cfg.id);
  const extra = (tok?.extra ?? {}) as { id_token?: string };
  const accountId = extractAccountIdFromIdToken(extra.id_token ?? null);
  const baseURL = (cfg.base_url ?? CHATGPT_CODEX_BASE_URL).replace(/\/$/, '');
  return new ChatGPTProvider({
    apiKey: token,
    model,
    baseURL,
    accountId,
  });
}

/**
 * Build a Google OAuth-backed Gemini provider for the indexer. Refreshes
 * the access token, then returns a GeminiProvider using Bearer auth.
 */
async function buildGoogleOAuthAgentProvider(
  store: ProviderStore,
  cfg: ProviderConfig,
  model?: string,
): Promise<LLMProvider> {
  let token = cfg.api_key ?? '';
  try {
    const fresh = await refreshGoogleToken(store, cfg.id);
    if (fresh) token = fresh;
  } catch (e) {
    console.warn(`[google-oauth/indexer] refresh failed: ${(e as Error).message}`);
  }
  const tok = store.getOAuth(cfg.id);
  const refreshToken = tok?.refresh_token ?? undefined;
  const extra = (tok?.extra ?? {}) as { projectId?: string };
  return new GeminiProvider(undefined, model, token, refreshToken, extra.projectId);
}

/**
 * Synchronous construction of a DB-backed LLMProvider. Callers that may
 * pass an OAuth kind (copilot/chatgpt) should use
 * createProviderFromConfigAsync instead — it handles the token refresh
 * step before instantiation. This sync path throws for OAuth kinds.
 */
export function createProviderFromConfig(cfg: ProviderConfig, model?: string): LLMProvider {
  if (cfg.kind === 'copilot' || cfg.kind === 'chatgpt' || cfg.kind === 'google-oauth') {
    throw new Error(
      `Provider "${cfg.id}" (kind=${cfg.kind}) needs async construction ` +
        `(token refresh). Call createProviderFromConfigAsync instead.`
    );
  }

  switch (cfg.id) {
    // Known ids keep their dedicated classes so pricing/model-lists stay intact.
    case 'anthropic':
      return new AnthropicProvider(cfg.api_key ?? undefined, model, cfg.base_url ?? undefined);
    case 'openai':
      return new OpenAIProvider(cfg.api_key ?? undefined, model, cfg.base_url ?? undefined);
    case 'deepseek':
      return new DeepSeekProvider(cfg.api_key ?? undefined, model);
    case 'gemini':
      return new GeminiProvider(cfg.api_key ?? undefined, model);
    case 'zai':
      return new ZAIProvider(cfg.api_key ?? undefined, model, cfg.base_url ?? undefined);
  }

  switch (cfg.kind) {
    case 'anthropic':
      return new AnthropicProvider(cfg.api_key ?? undefined, model, cfg.base_url ?? undefined);
    case 'openai':
      return new OpenAIProvider(cfg.api_key ?? undefined, model, cfg.base_url ?? undefined);
    case 'gemini':
      return new GeminiProvider(cfg.api_key ?? undefined, model);
    case 'bedrock':
      throw new Error('Bedrock agent provider not yet implemented');
    default:
      throw new Error(`Unsupported provider kind for indexer: ${cfg.kind as string}`);
  }
}

/**
 * Async entry-point that transparently handles OAuth token refresh for
 * copilot/chatgpt kinds, then falls through to the sync path for
 * everything else. Prefer this in the indexer runtime and API server.
 */
export async function createProviderFromConfigAsync(
  cfg: ProviderConfig,
  model?: string
): Promise<LLMProvider> {
  if (cfg.kind === 'copilot') {
    const store = getStore();
    if (!store) throw new Error('Copilot provider requires the ProviderStore');
    return buildCopilotAgentProvider(store, cfg, model);
  }
  if (cfg.kind === 'chatgpt') {
    const store = getStore();
    if (!store) throw new Error('ChatGPT provider requires the ProviderStore');
    return buildChatGPTAgentProvider(store, cfg, model);
  }
  if (cfg.kind === 'google-oauth') {
    const store = getStore();
    if (!store) throw new Error('Google OAuth provider requires the ProviderStore');
    return buildGoogleOAuthAgentProvider(store, cfg, model);
  }
  return createProviderFromConfig(cfg, model);
}

export function createProvider(name?: ProviderName | string, model?: string): LLMProvider {
  const store = getStore();
  if (store && name) {
    const cfg = store.getProvider(name);
    if (cfg && cfg.enabled) return createProviderFromConfig(cfg, model);
  }
  if (store && !name) {
    // No explicit name: prefer the row marked is_default, else any enabled
    // one with use_for_agent=true.
    const rows = store.listProviders({ enabled: true, use_for_agent: true });
    const def = rows.find((r) => r.is_default) ?? rows[0];
    if (def) return createProviderFromConfig(def, model);
  }

  // Legacy path — exactly the v3.7 behaviour.
  const providerName = name ?? detectProvider();
  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider(undefined, model);
    case 'openai':
      return new OpenAIProvider(undefined, model);
    case 'deepseek':
      return new DeepSeekProvider(undefined, model);
    case 'gemini':
      return new GeminiProvider(undefined, model);
    case 'zai':
      return new ZAIProvider(undefined, model);
    default:
      throw new Error(`Unknown provider: ${providerName}. Available: anthropic, openai, deepseek, gemini, zai`);
  }
}

/**
 * Async counterpart of createProvider that honors OAuth kinds. Callers in
 * the API server / CLI / MCP server should use this so copilot and chatgpt
 * rows can be selected for indexing (token refresh is handled inside).
 */
export async function createProviderAsync(
  name?: ProviderName | string,
  model?: string
): Promise<LLMProvider> {
  const store = getStore();
  if (store && name) {
    const cfg = store.getProvider(name);
    if (cfg && cfg.enabled) return createProviderFromConfigAsync(cfg, model);
  }
  if (store && !name) {
    const rows = store.listProviders({ enabled: true, use_for_agent: true });
    const def = rows.find((r) => r.is_default) ?? rows[0];
    if (def) return createProviderFromConfigAsync(def, model);
  }
  // Fall through to the sync legacy path.
  return createProvider(name, model);
}

function detectProvider(): ProviderName {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.ZAI_API_KEY) return 'zai';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  throw new Error(
    'No API key configured. Set one of: ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, ZAI_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY'
  );
}
