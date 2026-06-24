import type { ProviderSpec, ResolvedCreds, ProviderDefinition } from '@mcp/provider-sdk';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';
import { OpenAIProvider } from '@mcp/indexer/indexer/providers/openai.js';
import { ZAIProvider } from '@mcp/indexer/indexer/providers/zai.js';
import { DeepSeekProvider } from '@mcp/indexer/indexer/providers/deepseek.js';
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
  'createCoder' | 'createIndexer' | 'createIndexerAsync' | 'fetchModels' | 'testConnection'
>;

/**
 * OpenAI-compatible chat/completions wire (openai, openrouter, zai, deepseek,
 * cloudflare, copilot). Lift of the per-definition `createCoder`/`createIndexer`
 * with constants read from `spec.wireOpts` instead of inline. The indexer uses
 * the vendor-appropriate wrapper (ZAIProvider/DeepSeekProvider) so the
 * constructed adapter is behaviorally identical to today.
 */
export function buildOpenAICompat(spec: ProviderSpec): WireParts {
  const vendor = spec.wireOpts?.vendor;

  const coderModel = (model?: string) =>
    parseModelWithMode(model).model ?? spec.defaultModel ?? spec.defaultModels[0];

  const summaryModel = (creds: ResolvedCreds): string | undefined => {
    const extra = creds.extra?.summary_model;
    return typeof extra === 'string' && extra.trim().length > 0
      ? extra.trim()
      : spec.wireOpts?.summaryModelDefault;
  };

  return {
    createCoder: (creds, model) => {
      const parsed = parseModelWithMode(model);
      const baseURL = resolveBaseURL(spec, creds, parsed.mode);
      const baseModel = parsed.model ?? spec.defaultModel ?? spec.defaultModels[0];

      // Fast path: no `request` descriptor → byte-identical to the native wire.
      if (!spec.request) {
        return new OpenAIChatProvider({
          name: spec.kind,
          apiKey: creds.apiKey,
          baseURL,
          model: baseModel,
          defaultHeaders: resolveHeaders(spec, creds),
          vendor,
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
      });
    },

    createIndexer: (creds, model) => {
      const parsed = parseModelWithMode(model);
      // Vendor wrappers self-resolve their baseURL/defaults — pass through.
      if (vendor === 'zai') return new ZAIProvider(creds.apiKey, parsed.model, creds.baseURL);
      if (vendor === 'deepseek') return new DeepSeekProvider(creds.apiKey, parsed.model);
      return new OpenAIProvider(
        creds.apiKey,
        parsed.model ?? spec.wireOpts?.indexerDefaultModel,
        resolveBaseURL(spec, creds, undefined),
        resolveHeaders(spec, creds),
        summaryModel(creds),
      );
    },
  };
}
