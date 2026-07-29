import {
  parseRuntimeModelRef,
  selectRuntimeModelMetadata,
  type ProviderSpec,
  type ProviderDefinition,
} from '@mcp/provider-sdk';
import {
  ANTHROPIC_EXTENDED_CACHE_TTL_BETA,
  AnthropicChatProvider,
  resolveAnthropicRequestModel,
} from '@mcp/code-agent/providers/anthropic.js';
import { buildClaudeCode } from './claude-code.js';

type WireParts = Pick<
  ProviderDefinition,
  'createCoder' | 'fetchModels' | 'testConnection'
>;

/**
 * Anthropic (api-key) coder wire with constants read from `spec.wireOpts`.
 *   - coder model default = `model ?? spec.defaultModel`
 *   - baseURL passes through `creds.baseURL` (the adapter defaults internally —
 *     no engine-side fallback)
 * Claude Code (bearer/OAuth, `wireOpts.claudeCode`) routes through the adaptive
 * resolveClaudeCodeModel path — delegated to ./claude-code.ts.
 */
export function buildAnthropic(spec: ProviderSpec): WireParts {
  if (spec.wireOpts?.claudeCode) return buildClaudeCode(spec);

  return {
    createCoder: (creds, model, opts) => {
      const selectedModel =
        model ?? spec.defaultModel ?? spec.defaultModels[0] ?? 'claude-sonnet-5';
      const wireModel = parseRuntimeModelRef(selectedModel).id;
      return new AnthropicChatProvider({
        apiKey: creds.apiKey,
        baseURL: creds.baseURL,
        model: wireModel,
        defaultThinking: spec.wireOpts?.defaultThinking,
        defaultBetas: [ANTHROPIC_EXTENDED_CACHE_TTL_BETA],
        useBetaMessages: true,
        cacheMessages: true,
        promptCacheTtl: '1h',
        resolveModel: (activeModel, req) =>
          resolveAnthropicRequestModel(
            parseRuntimeModelRef(activeModel).id,
            req,
            selectRuntimeModelMetadata(opts?.providerModels, activeModel),
          ),
      });
    },
  };
}
