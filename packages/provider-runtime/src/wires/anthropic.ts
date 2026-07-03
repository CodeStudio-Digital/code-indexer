import type { ProviderSpec, ResolvedCreds, ProviderDefinition } from '@mcp/provider-sdk';
import { AnthropicChatProvider } from '@mcp/code-agent/providers/anthropic.js';
import { AnthropicProvider } from '@mcp/indexer/indexer/providers/anthropic.js';
import { buildClaudeCode } from './claude-code.js';

type WireParts = Pick<
  ProviderDefinition,
  'createCoder' | 'createIndexer' | 'createIndexerAsync' | 'fetchModels' | 'testConnection'
>;

/**
 * Anthropic (api-key) wire. Lift of the hand-written `createCoder`/`createIndexer`
 * with the constants (`defaultThinking`, `summaryModelDefault`) read from
 * `spec.wireOpts` instead of inline. Both the coder and the indexer talk to the
 * single Anthropic vendor, so:
 *   - coder model default = `model ?? spec.defaultModel`
 *   - baseURL passes through `creds.baseURL` (the adapter defaults internally —
 *     no host-side fallback)
 *   - the indexer's 4th ctor arg is an OPTIONS OBJECT `{ summaryModel }`, not a
 *     positional arg, with the cheap summary default coming from
 *     `wireOpts.summaryModelDefault` (overridable via `extra.summary_model`).
 *
 * Claude Code (bearer/OAuth, `wireOpts.claudeCode`) routes through the adaptive
 * resolveClaudeCodeModel path — delegated to ./claude-code.ts.
 */
export function buildAnthropic(spec: ProviderSpec): WireParts {
  if (spec.wireOpts?.claudeCode) return buildClaudeCode(spec);

  const summaryModel = (creds: ResolvedCreds): string | undefined => {
    const extra = creds.extra?.summary_model;
    return typeof extra === 'string' ? extra : spec.wireOpts?.summaryModelDefault;
  };

  return {
    createCoder: (creds, model) =>
      new AnthropicChatProvider({
        apiKey: creds.apiKey,
        baseURL: creds.baseURL,
        model: model ?? spec.defaultModel,
        defaultThinking: spec.wireOpts?.defaultThinking,
      }),

    createIndexer: (creds, model) =>
      new AnthropicProvider(creds.apiKey, model, creds.baseURL, {
        summaryModel: summaryModel(creds),
      }),
  };
}
