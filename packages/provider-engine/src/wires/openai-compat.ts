import type { ProviderSpec, ResolvedCreds, ProviderDefinition } from '@mcp/provider-sdk';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';
import { OpenAIProvider } from '@mcp/indexer/indexer/providers/openai.js';
import { ZAIProvider } from '@mcp/indexer/indexer/providers/zai.js';
import { DeepSeekProvider } from '@mcp/indexer/indexer/providers/deepseek.js';
import { parseModelWithMode } from '../wire-helpers/model-mode.js';
import { resolveBaseURL } from '../wire-helpers/base-url.js';
import { resolveHeaders } from '../wire-helpers/headers.js';

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
      return new OpenAIChatProvider({
        name: spec.kind,
        apiKey: creds.apiKey,
        baseURL: resolveBaseURL(spec, creds, parsed.mode),
        model: parsed.model ?? spec.defaultModel ?? spec.defaultModels[0],
        defaultHeaders: resolveHeaders(spec, creds),
        vendor,
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
