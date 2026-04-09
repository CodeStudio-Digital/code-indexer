import type { ChatProvider, CoderProviderName } from './adapter.js';
import { AnthropicChatProvider } from './anthropic.js';
import { OpenAIChatProvider } from './openai.js';
import { GeminiChatProvider } from './gemini.js';
import { BedrockChatProvider } from './bedrock.js';
import {
  refreshIfExpired as refreshCopilotToken,
  copilotHeaders,
  getStoredCopilotOpts,
} from '../../services/oauth/copilot.js';
import {
  refreshIfExpired as refreshOpenAIToken,
  CHATGPT_CODEX_BASE_URL,
} from '../../services/oauth/openai.js';
import { ChatGPTCodexProvider, extractAccountIdFromIdToken } from './chatgpt.js';
import { ProviderStore, type ProviderConfig } from '../../../store/provider-store.js';
import { loadConfig } from '../../../utils/config.js';

const ZAI_CODING_MODELS = new Set(['glm-5.1', 'glm-5-turbo', 'glm-4-plus', 'codegeex-4', 'codegeex-4-flash']);
const ZAI_GENERAL_URL = 'https://api.z.ai/api/paas/v4/';
const ZAI_CODING_URL = 'https://api.z.ai/api/coding/paas/v4/';

/**
 * Lazily-opened shared store. Using a singleton avoids reopening the SQLite
 * file on every createChatProvider() call (the runner swaps providers mid
 * session for /switch). Migration 006 already ran when the API server or CLI
 * opened the DB the first time, so by the time this runs the tables exist.
 */
let cachedStore: ProviderStore | null = null;
function getStore(): ProviderStore {
  if (cachedStore) return cachedStore;
  const cfg = loadConfig();
  cachedStore = new ProviderStore(cfg.dbPath);
  cachedStore.seedFromEnvIfEmpty();
  return cachedStore;
}

/**
 * Build a ChatProvider from a DB-backed ProviderConfig. This is the canonical
 * path — all the env-variable lookups become explicit fields on the config.
 * Called by both createChatProvider (when a DB row exists) and by the admin
 * "test connection" endpoint.
 */
/**
 * Decode a model string that may carry a mode suffix encoded by the dashboard
 * (e.g. "glm-5.1::coding"). Returns the bare model id and the mode (or
 * undefined). This is the inverse of the encoding in AgentChat's provider
 * select — when the user picks the ZAI coding variant, the Select value is
 * `${modelId}::${mode}` so the server knows which variant to instantiate.
 */
function parseModelWithMode(raw: string | undefined): { model: string | undefined; mode: string | undefined } {
  // Treat empty string and undefined identically. The dashboard sends
  // `model: ""` when the user picked a provider but left the model blank,
  // and `?? default` further down wouldn't catch that — it would pass "" to
  // the vendor API and get a silent 400.
  if (!raw) return { model: undefined, mode: undefined };
  const idx = raw.indexOf('::');
  if (idx === -1) return { model: raw || undefined, mode: undefined };
  const m = raw.slice(0, idx);
  const mode = raw.slice(idx + 2);
  return { model: m || undefined, mode: mode || undefined };
}

export function createChatProviderFromConfig(cfg: ProviderConfig, model?: string, mode?: string): ChatProvider {
  // Accept `${modelId}::${mode}` in the `model` arg so callers that don't
  // track mode separately (the session record, /switch endpoint) still work.
  const parsed = parseModelWithMode(model);
  const effectiveModel = parsed.model;
  const effectiveMode = mode ?? parsed.mode;

  switch (cfg.kind) {
    case 'anthropic':
      return new AnthropicChatProvider({
        apiKey: cfg.api_key ?? undefined,
        baseURL: cfg.base_url ?? undefined,
        model: effectiveModel ?? 'claude-sonnet-4-6',
      });

    case 'openai': {
      // ZAI splits its general and coding APIs across two base URLs. If the
      // caller didn't override base_url, pick the right one based on mode (or
      // legacy model-name heuristic) so existing sessions keep working.
      let baseURL = cfg.base_url ?? undefined;
      const isZai = cfg.id === 'zai' || cfg.extra?.zai_has_coding_mode === true;
      if (isZai) {
        const m = effectiveModel ?? 'glm-5.1';
        const wantsCoding = effectiveMode === 'coding' || (!effectiveMode && ZAI_CODING_MODELS.has(m));
        baseURL = process.env.ZAI_BASE_URL ?? (wantsCoding ? ZAI_CODING_URL : ZAI_GENERAL_URL);
      }
      return new OpenAIChatProvider({
        name: cfg.id,
        apiKey: cfg.api_key ?? undefined,
        baseURL,
        model: effectiveModel ?? 'gpt-4o-mini',
      });
    }

    case 'chatgpt': {
      // ChatGPT (Codex PKCE OAuth) uses the Responses API, not chat
      // completions. Dedicated adapter handles the input/event shape;
      // see src/coder/providers/chatgpt.ts. The ChatGPT-Account-Id
      // header is extracted from the id_token stored in oauth_tokens.extra
      // at connect time — Codex gates every request on it.
      const baseURL = (cfg.base_url ?? CHATGPT_CODEX_BASE_URL).replace(/\/$/, '');
      let accountId: string | null = null;
      try {
        const store = getStore();
        const tok = store.getOAuth(cfg.id);
        const extra = (tok?.extra ?? {}) as { id_token?: string };
        accountId = extractAccountIdFromIdToken(extra.id_token ?? null);
      } catch {
        /* DB unavailable — proceed without account id; may 401 */
      }
      return new ChatGPTCodexProvider({
        name: cfg.id,
        apiKey: cfg.api_key ?? '',
        baseURL,
        model: effectiveModel ?? 'gpt-5.3-codex',
        accountId,
      });
    }

    case 'copilot': {
      // Copilot's OpenAI-compatible endpoint requires the full editor
      // header set on every request — not just Authorization. We also prefer
      // the `endpoints.api` value the token exchange published (stored in
      // oauth_tokens.extra.endpoints) over the provider_configs.base_url
      // mirror, since enterprise instances advertise their edge there.
      let baseURL = cfg.base_url ?? 'https://api.githubcopilot.com';
      let opts: ReturnType<typeof getStoredCopilotOpts> = { edition: 'individual' };
      try {
        const store = getStore();
        opts = getStoredCopilotOpts(store, cfg.id);
        const tok = store.getOAuth(cfg.id);
        const extra = (tok?.extra ?? {}) as { endpoints?: Record<string, string> };
        if (extra.endpoints?.api) baseURL = extra.endpoints.api;
      } catch {
        /* DB unavailable — use provider_configs.base_url as-is */
      }
      // Let the OpenAI SDK own Authorization (via apiKey). Pass the rest
      // of the Copilot editor headers via defaultHeaders so they're sent
      // on every /chat/completions request without double-auth.
      const { Authorization: _omit, ...editorHeaders } = copilotHeaders(
        cfg.api_key ?? '',
        opts
      );
      void _omit;
      return new OpenAIChatProvider({
        name: cfg.id,
        apiKey: cfg.api_key ?? undefined,
        baseURL: baseURL.replace(/\/$/, ''),
        model: effectiveModel ?? 'gpt-4o',
        defaultHeaders: editorHeaders,
      });
    }

    case 'gemini':
      // Native Gemini via @google/genai — gives access to thinking mode,
      // context caching and the first-party function calling schema that
      // the OpenAI-compat shim doesn't expose.
      return new GeminiChatProvider({
        apiKey: cfg.api_key ?? undefined,
        model: effectiveModel ?? 'gemini-2.5-flash',
      });

    case 'bedrock': {
      // AWS credentials are stashed in oauth_tokens.extra (see
      // src/api/admin.ts POST /oauth/bedrock/credentials). The legacy AWS
      // credential chain still works as a fallback when oauth_tokens is
      // empty — useful for EC2/ECS instance roles.
      let creds: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; region?: string } = {};
      try {
        const store = getStore();
        const tok = store.getOAuth(cfg.id);
        if (tok) {
          const extra = tok.extra as {
            accessKeyId?: string;
            secretAccessKey?: string;
            sessionToken?: string;
            region?: string;
          };
          creds = {
            accessKeyId: extra.accessKeyId,
            secretAccessKey: extra.secretAccessKey,
            sessionToken: extra.sessionToken,
            region: extra.region ?? (cfg.extra?.aws_region as string | undefined),
          };
        } else {
          creds.region = cfg.extra?.aws_region as string | undefined;
        }
      } catch {
        /* fall back to AWS default credential chain */
      }
      return new BedrockChatProvider({
        model: effectiveModel,
        region: creds.region,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
      });
    }

    default:
      throw new Error(`Unknown provider kind: ${cfg.kind as string}`);
  }
}

/**
 * Backwards-compatible entrypoint. Tries the DB-backed store first; if the
 * provider id is not registered (fresh install, legacy caller, or a built-in
 * name like "deepseek" that wasn't in .env during seed), falls back to the
 * original hardcoded switch. This keeps the coder agent working during the
 * rollout without any config migration step.
 */
export function createChatProvider(name: CoderProviderName | string, model?: string): ChatProvider {
  // Strip "::mode" suffix encoded by the dashboard. Both the DB path
  // (createChatProviderFromConfig) and the legacy path below need the bare
  // model id before they can instantiate an adapter — otherwise the vendor
  // API rejects "glm-5.1::coding" as an unknown model.
  const { model: bareModel, mode: encodedMode } = parseModelWithMode(model);

  try {
    const store = getStore();
    const cfg = store.getProvider(name);
    if (cfg && cfg.enabled) return createChatProviderFromConfig(cfg, bareModel, encodedMode);
  } catch {
    // DB unavailable (e.g. unit test with no filesystem) — fall through.
  }

  // Legacy path, unchanged from v3.7 except for mode-aware ZAI URL selection.
  switch (name) {
    case 'anthropic':
      return new AnthropicChatProvider({ model: bareModel ?? 'claude-sonnet-4-6' });

    case 'openai':
      return new OpenAIChatProvider({ name: 'openai', model: bareModel ?? 'gpt-4o-mini' });

    case 'zai': {
      const m = bareModel ?? 'glm-5.1';
      const wantsCoding = encodedMode === 'coding' || (!encodedMode && ZAI_CODING_MODELS.has(m));
      const baseURL = process.env.ZAI_BASE_URL ?? (wantsCoding ? ZAI_CODING_URL : ZAI_GENERAL_URL);
      return new OpenAIChatProvider({
        name: 'zai',
        apiKey: process.env.ZAI_API_KEY,
        baseURL,
        model: m,
      });
    }

    case 'deepseek':
      return new OpenAIChatProvider({
        name: 'deepseek',
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: 'https://api.deepseek.com/v1',
        model: bareModel ?? 'deepseek-chat',
      });

    case 'gemini':
      return new GeminiChatProvider({
        apiKey: process.env.GEMINI_API_KEY,
        model: bareModel ?? 'gemini-2.5-flash',
      });

    default:
      throw new Error(`Unknown coder provider: ${name as string}`);
  }
}

export const SUPPORTED_CODER_PROVIDERS: CoderProviderName[] = ['anthropic', 'openai', 'zai', 'deepseek'];

/**
 * Async wrapper around createChatProvider that handles credential refresh
 * for providers whose tokens expire (currently: GitHub Copilot, whose
 * Copilot API token only lives ~25min and has to be re-exchanged from the
 * stored GitHub PAT).
 *
 * Call this from runtime code paths (runner startup, /switch endpoint)
 * instead of createChatProvider so the user never sees a 401 mid-session
 * just because the token aged out.
 *
 * For all other providers it's a thin pass-through to the sync factory.
 */
export async function createChatProviderAsync(
  name: CoderProviderName | string,
  model?: string
): Promise<ChatProvider> {
  // Refresh Copilot tokens before instantiation. We re-resolve the cfg here
  // so the synced api_key (which createChatProviderFromConfig uses) is the
  // freshly minted Copilot token, not the old one.
  try {
    const store = getStore();
    const cfg = store.getProvider(name);
    if (cfg?.kind === 'copilot' && cfg.enabled) {
      const fresh = await refreshCopilotToken(store, cfg.id);
      if (fresh && fresh !== cfg.api_key) {
        // refreshIfExpired writes the new token into oauth_tokens but the
        // provider_configs.api_key mirror has to be updated separately so
        // createChatProviderFromConfig sees it.
        store.upsertProvider({ ...cfg, api_key: fresh });
      }
    }
    if (cfg?.kind === 'chatgpt' && cfg.enabled) {
      const fresh = await refreshOpenAIToken(store, cfg.id);
      if (fresh && fresh !== cfg.api_key) {
        store.upsertProvider({ ...cfg, api_key: fresh });
      }
    }
  } catch (e) {
    // Don't block the run on a refresh failure — the existing token may
    // still be valid for a few minutes. Surface to logs only.
    console.warn(`[copilot] token refresh failed: ${(e as Error).message}`);
  }
  return createChatProvider(name, model);
}
