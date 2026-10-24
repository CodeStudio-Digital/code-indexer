import {
  parseRuntimeModelRef,
  selectRuntimeModelMetadata,
  type ProviderSpec,
  type ResolvedCreds,
  type ProviderDefinition,
  type CreateCoderOpts,
} from '@mcp/provider-sdk';
import { ChatGPTCodexProvider } from '@mcp/code-agent/providers/chatgpt.js';
import { getStore } from '@mcp/services/providers/shared/store.js';

type WireParts = Pick<
  ProviderDefinition,
  'createCoder' | 'fetchModels' | 'testConnection'
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
    createCoder: (creds: ResolvedCreds, model?: string, opts?: CreateCoderOpts) => {
      const resolvedModel = model ?? spec.defaultModel ?? spec.defaultModels[0];
      const wireModel = parseRuntimeModelRef(resolvedModel).id;

      // Reasoning capability + apply_patch tool type from the persisted
      // provider_models row (migration 052 + live discovery). Best-effort.
      let reasoning: { supportedLevels?: string[] | null; defaultLevel?: string | null } | undefined;
      let applyPatchToolType: string | null = null;
      try {
        const store = getStore();
        const providerId = opts?.providerId;
        const models = opts?.providerModels ?? (store && providerId ? store.listModels(providerId) : undefined);
        const row = selectRuntimeModelMetadata(models, resolvedModel);
        if (row) {
          reasoning = {
            supportedLevels: row.supported_reasoning_levels,
            defaultLevel: row.default_reasoning_level,
          };
          applyPatchToolType = row.apply_patch_tool_type ?? null;
        }
      } catch {
        // ignore — provider still constructed without reasoning capability
      }

      const imageGenOptIn = process.env.CODEX_IMAGE_GEN_ENABLED === '1';
      const imageAllow = (process.env.CODEX_IMAGE_GEN_MODELS ?? 'gpt-6.1-sol,gpt-6-astra,gpt-6-sol,gpt-6-luna,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const imageGenerationEnabled = imageGenOptIn && imageAllow.includes(wireModel);

      return new ChatGPTCodexProvider({
        apiKey: creds.apiKey ?? '',
        baseURL: creds.baseURL ?? DEFAULT_BASE_URL,
        accountId: (creds.extra?.accountId as string | null | undefined) ?? null,
        model: wireModel,
        reasoning,
        reasoningSummary: 'auto',
        reasoningSummaryFromThinking: true,
        parallelToolCalls: GPT_56_CODEX_MODELS.has(wireModel.toLowerCase()),
        applyPatchToolType,
        imageGenerationEnabled,
      });
    },
  };
}

const GPT_56_CODEX_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);
