import type { ProviderSpec, ResolvedCreds, ProviderDefinition, CreateCoderOpts } from '@mcp/provider-sdk';
import { ChatGPTCodexProvider } from '@mcp/code-agent/providers/chatgpt.js';
import { ChatGPTProvider } from '@mcp/indexer/indexer/providers/chatgpt.js';
import { getStore } from '@mcp/services/providers/shared/store.js';

type WireParts = Pick<
  ProviderDefinition,
  'createCoder' | 'createIndexer' | 'createIndexerAsync' | 'fetchModels' | 'testConnection'
>;

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/**
 * Codex wire (chatgpt) — the OpenAI Responses API (stateful), NOT chat/completions.
 * Per-instance reasoning capability + apply_patch tool type read live from
 * `provider_models` (via getStore + the provider row id in `opts.providerId`,
 * falling back to none), plus the env-gated server-managed image_generation tool.
 */
export function buildCodex(spec: ProviderSpec): WireParts {
  return {
    createIndexer: (creds: ResolvedCreds, model?: string) =>
      new ChatGPTProvider({
        apiKey: creds.apiKey ?? '',
        model,
        baseURL: creds.baseURL ?? DEFAULT_BASE_URL,
        accountId: (creds.extra?.accountId as string | null | undefined) ?? null,
      }),

    createCoder: (creds: ResolvedCreds, model?: string, opts?: CreateCoderOpts) => {
      const resolvedModel = model ?? spec.defaultModel ?? spec.defaultModels[0];

      // Reasoning capability + apply_patch tool type from the persisted
      // provider_models row (migration 052 + live discovery). Best-effort.
      let reasoning: { supportedLevels?: string[] | null; defaultLevel?: string | null } | undefined;
      let applyPatchToolType: string | null = null;
      try {
        const store = getStore();
        const providerId = opts?.providerId;
        if (store && providerId) {
          const row = store.listModels(providerId).find((m) => m.model_id === resolvedModel);
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

      const imageGenOptIn = process.env.CODEX_IMAGE_GEN_ENABLED === '1';
      const imageAllow = (process.env.CODEX_IMAGE_GEN_MODELS ?? 'gpt-5.5,gpt-5.4,gpt-5.4-mini')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const imageGenerationEnabled = imageGenOptIn && imageAllow.includes(resolvedModel);

      return new ChatGPTCodexProvider({
        apiKey: creds.apiKey ?? '',
        baseURL: creds.baseURL ?? DEFAULT_BASE_URL,
        accountId: (creds.extra?.accountId as string | null | undefined) ?? null,
        model: resolvedModel,
        reasoning,
        applyPatchToolType,
        imageGenerationEnabled,
      });
    },
  };
}
