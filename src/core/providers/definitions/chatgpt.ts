import { defineProvider } from '../types.js';
import { ChatGPTProvider } from '../../indexer/providers/chatgpt.js';
import { ChatGPTCodexProvider } from '../../coder/providers/chatgpt.js';
import { getStore } from '../shared/store.js';

/**
 * ChatGPT (Codex PKCE OAuth). credKind='oauth' — `resolveCreds` dispatches
 * to `resolveChatGPTCreds` which refreshes the access token, extracts the
 * chatgpt_account_id from the id_token JWT, and exposes both via
 * ResolvedCreds.
 */
export const chatgpt = defineProvider({
  kind: 'chatgpt',
  displayName: 'ChatGPT (Codex OAuth)',
  credKind: 'oauth',
  envVars: [],
  defaultModels: ['gpt-5.3-codex', 'gpt-5-codex', 'gpt-4o'],
  pricing: {
    'gpt-5.3-codex': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gpt-5-codex':   { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gpt-4o':        { inputPer1M: 2.50, outputPer1M: 10.00 },
  },
  createIndexer: (creds, model) =>
    new ChatGPTProvider({
      apiKey: creds.apiKey ?? '',
      model,
      baseURL: creds.baseURL ?? 'https://chatgpt.com/backend-api/codex',
      accountId: (creds.extra?.accountId as string | null | undefined) ?? null,
    }),
  createCoder: (creds, model, opts) => {
    const resolvedModel = model ?? 'gpt-5.3-codex';
    // Look up reasoning capability from the persisted provider_models row
    // (populated by migration 052 + the live `/models` discovery). Best-effort
    // — when the row is missing we still build the provider, just without
    // reasoning capability info, so the backend uses the model's own default.
    let reasoning: { supportedLevels?: string[] | null; defaultLevel?: string | null } | undefined;
    let applyPatchToolType: string | null = null;
    try {
      const store = getStore();
      const providerId = opts?.providerId;
      if (store && providerId) {
        const row = store
          .listModels(providerId)
          .find((m) => m.model_id === resolvedModel);
        if (row) {
          reasoning = {
            supportedLevels: row.supported_reasoning_levels,
            defaultLevel: row.default_reasoning_level,
          };
          applyPatchToolType = row.apply_patch_tool_type;
        }
      }
    } catch {
      // ignore — provider still constructed without reasoning capability
    }

    // Image-generation gating. Opt-in via CODEX_IMAGE_GEN_ENABLED=1 because
    // the chatgpt.com OAuth backend isn't documented to expose the
    // server-managed `image_generation` tool to every account, and an
    // unsupported tool entry can cause the model to spin without progress.
    // CODEX_IMAGE_GEN_MODELS narrows the allowlist further when the flag
    // is on (default covers gpt-5.x).
    const imageGenOptIn = process.env.CODEX_IMAGE_GEN_ENABLED === '1';
    const imageAllow = (process.env.CODEX_IMAGE_GEN_MODELS ?? 'gpt-5.5,gpt-5.4,gpt-5.4-mini')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const imageGenerationEnabled = imageGenOptIn && imageAllow.includes(resolvedModel);

    return new ChatGPTCodexProvider({
      apiKey: creds.apiKey ?? '',
      baseURL: creds.baseURL ?? 'https://chatgpt.com/backend-api/codex',
      accountId: (creds.extra?.accountId as string | null | undefined) ?? null,
      model: resolvedModel,
      reasoning,
      applyPatchToolType,
      imageGenerationEnabled,
    });
  },
});
