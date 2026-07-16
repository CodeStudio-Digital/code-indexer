import type { ProviderSpec, ResolvedCreds, ProviderDefinition } from '@mcp/provider-sdk';
import { KimiCodeChatProvider } from '@mcp/code-agent/providers/kimi-code.js';

type WireParts = Pick<
  ProviderDefinition,
  'createCoder' | 'fetchModels' | 'testConnection'
>;

type KimiThinkingMode = 'auto' | 'enabled' | 'disabled';

/**
 * Replicates the definition's inline `readKimiCodeThinkingMode`: a value is
 * honored only when it is one of the three legal modes, otherwise it falls back
 * to `'auto'`. The default is sourced from `spec.wireOpts.thinkingMode.default`
 * (declared as `'auto'`) so the data and the behavior stay in lockstep.
 */
function readThinkingMode(value: unknown, fallback: KimiThinkingMode): KimiThinkingMode {
  return value === 'enabled' || value === 'disabled' || value === 'auto' ? value : fallback;
}

/**
 * Kimi Code wire (kimi-code, OAuth credentials resolved upstream). Lift of the
 * hand-written coder adapter with the base-URL fallback and the
 * default model read from the spec, and the per-request thinking mode read from
 * `creds.extra` per `spec.wireOpts.thinkingMode`. The OAuth flow itself is added
 * separately — here creds arrive already resolved.
 */
export function buildKimi(spec: ProviderSpec): WireParts {
  const thinkingOpts = spec.wireOpts?.thinkingMode;
  const thinkingDefault: KimiThinkingMode = thinkingOpts?.default ?? 'auto';
  const defaultModel = spec.defaultModel ?? spec.defaultModels[0];
  const baseURL = (creds: ResolvedCreds): string | undefined =>
    creds.baseURL ?? spec.defaultBaseURL;

  return {
    createCoder: (creds, model) =>
      new KimiCodeChatProvider({
        apiKey: creds.apiKey,
        baseURL: baseURL(creds),
        model: model ?? defaultModel,
        defaultHeaders: creds.extraHeaders,
        thinkingMode: readThinkingMode(
          thinkingOpts ? creds.extra?.[thinkingOpts.key] : undefined,
          thinkingDefault,
        ),
      }),
  };
}
