import {
  selectRuntimeModelMetadata,
  type ProviderSpec,
  type ProviderDefinition,
} from '@mcp/provider-sdk';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';
import { ChatGPTCodexProvider } from '@mcp/code-agent/providers/chatgpt.js';
import { getOpenAIApiModelMetadata } from '@mcp/shared/providers/openai-api-models.js';
import { parseModelWithMode } from '../wire-helpers/model-mode.js';
import { resolveBaseURL } from '../wire-helpers/base-url.js';
import { resolveHeaders } from '../wire-helpers/headers.js';
import {
  requestStaticHeaders,
  requestAuthHeader,
  requestQuery,
  rewriteModelId,
} from '../wire-helpers/request.js';

type WireParts = Pick<
  ProviderDefinition,
  'createCoder' | 'fetchModels' | 'testConnection'
>;

/**
 * OpenAI-compatible chat/completions wire (openai, openrouter, zai, deepseek,
 * cloudflare, copilot, mistral). Constants come from `spec.wireOpts` rather than an
 * inline provider switch.
 */
export function buildOpenAICompat(spec: ProviderSpec): WireParts {
  const vendor = spec.wireOpts?.vendor;

  const coderModel = (model?: string) =>
    parseModelWithMode(model).model ?? spec.defaultModel ?? spec.defaultModels[0];

  return {
    createCoder: (creds, model, opts) => {
      const parsed = parseModelWithMode(model);
      const baseURL = resolveBaseURL(spec, creds, parsed.mode);
      const baseModel = parsed.model ?? spec.defaultModel ?? spec.defaultModels[0];
      const modelMaxOutputTokens: Record<string, number> = Object.fromEntries(
        (opts?.providerModels ?? [])
          .filter((entry) => (
            (entry.mode ?? '') === ''
            &&
            typeof entry.default_max_tokens === 'number' && entry.default_max_tokens > 0
          ))
          .map((entry) => [entry.model_id, entry.default_max_tokens as number]),
      );
      const activeMetadata = selectRuntimeModelMetadata(opts?.providerModels, model ?? baseModel);
      const seedMetadata = spec.models?.[baseModel]
        ?? (spec.kind === 'openai' ? getOpenAIApiModelMetadata(baseModel) : undefined);
      if (typeof activeMetadata?.default_max_tokens === 'number' && activeMetadata.default_max_tokens > 0) {
        modelMaxOutputTokens[baseModel] = activeMetadata.default_max_tokens;
      }
      const persistedOutputLimits = Object.keys(modelMaxOutputTokens).length > 0
        ? modelMaxOutputTokens
        : undefined;

      // Custom instances of the OpenAI shape promise chat/completions, not the
      // official Responses protocol (local proxies may also be keyless).
      const officialOpenAI = baseURL && new URL(baseURL).origin === 'https://api.openai.com';
      if (spec.wireOpts?.responsesApi && (spec.kind !== 'openai' || officialOpenAI)) {
        if (!baseURL) {
          throw new Error(`${spec.displayName} Responses API requires a base URL`);
        }
        if (!baseModel) {
          throw new Error(`${spec.displayName} Responses API requires a model`);
        }
        if (!creds.apiKey) {
          throw new Error(`${spec.displayName} Responses API requires an API key`);
        }
        return new ChatGPTCodexProvider({
          name: spec.kind,
          apiKey: creds.apiKey,
          baseURL,
          model: baseModel,
          reasoning: {
            supportedLevels: activeMetadata?.supported_reasoning_levels ?? seedMetadata?.supportedReasoningLevels,
            defaultLevel: activeMetadata ? activeMetadata.default_reasoning_level : seedMetadata?.defaultReasoningLevel,
          },
          applyPatchToolType: activeMetadata?.apply_patch_tool_type ?? seedMetadata?.applyPatchToolType,
          codexHeaders: false,
          statefulResponses: spec.wireOpts.responsesStateless !== true,
          reasoningFromThinking:
            spec.wireOpts.responsesReasoningFromThinking === true,
          reasoningSummary: (spec.kind === 'openai' && seedMetadata?.canReason)
            || spec.wireOpts.responsesReasoningSummaryModels?.includes(baseModel)
            ? 'auto'
            : null,
          includeOrchestrationUsage:
            spec.wireOpts.responsesIncludeOrchestrationUsage === true,
        });
      }

      // Fast path: no `request` descriptor → byte-identical to the native wire.
      if (!spec.request) {
        return new OpenAIChatProvider({
          name: spec.kind,
          apiKey: creds.apiKey,
          baseURL,
          model: baseModel,
          defaultHeaders: resolveHeaders(spec, creds),
          vendor,
          modelMaxOutputTokens: persistedOutputLimits,
        });
      }

      // Declarative request shaping (custom auth header, extra headers, query,
      // model rewrite, static body inject/remove, response key mapping).
      const finalModel = rewriteModelId(spec, baseModel);
      const ctx = { apiKey: creds.apiKey, baseURL, model: finalModel, creds };
      const authHeader = requestAuthHeader(spec, ctx);
      return new OpenAIChatProvider({
        name: spec.kind,
        // When the descriptor owns auth, suppress the SDK's Authorization (the
        // adapter sets the custom header + drops Authorization).
        apiKey: authHeader ? '' : creds.apiKey,
        baseURL,
        model: finalModel,
        defaultHeaders: requestStaticHeaders(spec, ctx, resolveHeaders(spec, creds)),
        vendor,
        authHeader,
        defaultQuery: requestQuery(spec, ctx),
        bodyInject: spec.request.body?.inject,
        bodyRemove: spec.request.body?.remove,
        reasoningDeltaKey: spec.request.response?.reasoningDeltaKey,
        modelMaxOutputTokens: persistedOutputLimits,
      });
    },
  };
}
