import type { ProviderSpec, ResolvedCreds, ProviderDefinition } from '@mcp/provider-sdk';
import { GeminiChatProvider } from '@mcp/code-agent/providers/gemini.js';
import { GeminiProvider } from '@mcp/indexer/indexer/providers/gemini.js';

type WireParts = Pick<
  ProviderDefinition,
  'createCoder' | 'createIndexer' | 'createIndexerAsync' | 'fetchModels' | 'testConnection'
>;

/**
 * Native Gemini wire. Two modes selected by `spec.wireOpts.geminiOAuth`:
 *  - api-key (gemini): `apiKey` straight through.
 *  - OAuth (google-oauth): the resolved token arrives as `creds.apiKey` and is
 *    passed as `accessToken`, alongside `refreshToken`/`projectId` from
 *    `creds.extra` and `cloudCodeSessionId` from `opts` — routing through the
 *    CloudCode backend, exactly like the `google-oauth` definition.
 */
export function buildGemini(spec: ProviderSpec): WireParts {
  if (spec.wireOpts?.geminiOAuth) {
    return {
      createCoder: (creds: ResolvedCreds, model?: string, opts?) =>
        new GeminiChatProvider({
          accessToken: creds.apiKey,
          refreshToken: creds.extra?.refreshToken as string | undefined,
          projectId: creds.extra?.projectId as string | undefined,
          cloudCodeSessionId: opts?.cloudCodeSessionId,
          // google-oauth's definition hardcodes this fallback in createCoder
          // while leaving `defaultModel` unset (defaultModelFor → defaultModels[0]).
          model: model ?? spec.defaultModel ?? 'gemini-2.5-flash',
        }),

      createIndexer: (creds: ResolvedCreds, model?: string) =>
        new GeminiProvider(
          undefined,
          model,
          creds.apiKey,
          creds.extra?.refreshToken as string | undefined,
          creds.extra?.projectId as string | undefined,
        ),
    };
  }

  return {
    createCoder: (creds: ResolvedCreds, model?: string) =>
      new GeminiChatProvider({
        apiKey: creds.apiKey,
        model: model ?? spec.defaultModel,
      }),

    createIndexer: (creds: ResolvedCreds, model?: string) =>
      new GeminiProvider(creds.apiKey, model),
  };
}
