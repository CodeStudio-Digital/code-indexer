import type { ProviderSpec, ProviderDefinition } from '@mcp/provider-sdk';
import {
  ANTHROPIC_EXTENDED_CACHE_TTL_BETA,
  AnthropicChatProvider,
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
 *     no host-side fallback)
 * Claude Code (bearer/OAuth, `wireOpts.claudeCode`) routes through the adaptive
 * resolveClaudeCodeModel path — delegated to ./claude-code.ts.
 */
export function buildAnthropic(spec: ProviderSpec): WireParts {
  if (spec.wireOpts?.claudeCode) return buildClaudeCode(spec);

  return {
    createCoder: (creds, model) =>
      new AnthropicChatProvider({
        apiKey: creds.apiKey,
        baseURL: creds.baseURL,
        model: model ?? spec.defaultModel,
        defaultThinking: spec.wireOpts?.defaultThinking,
        defaultBetas: [ANTHROPIC_EXTENDED_CACHE_TTL_BETA],
        useBetaMessages: true,
        cacheMessages: true,
        promptCacheTtl: '1h',
      }),
  };
}
