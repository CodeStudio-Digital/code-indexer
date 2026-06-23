/**
 * Z.AI / GLM as a PROVIDER PLUGIN — the reference for the `providers`
 * contribution point (Fase E). A near-verbatim lift of the built-in
 * `packages/services/src/providers/definitions/zai.ts`; the only difference is
 * that it ships in a plugin bundle instead of the core registry.
 *
 * The adapter bases (`OpenAIChatProvider`, `ZAIProvider`) and the SDK
 * (`defineProvider`, `parseModelWithMode`) are EXTERNAL in the built bundle and
 * resolved from the host process at load time — the provider-host loader runs
 * in-process where these modules already live, so an externalized import binds
 * to the host's single copy (no duplicate code-agent tree in the bundle). See
 * README.md for the required `esbuild --external:@mcp/*` build flags.
 *
 * When loaded by a TRUSTED enable (see the loader's trust gate), this provider
 * registers under kind `'zai'` and OVERRIDES the built-in via `upsertProvider`
 * — the migration path. Once proven end-to-end, the built-in zai definition is
 * deleted and this plugin becomes the sole source.
 */
import { definePlugin, contributeProvider } from '@mcp/plugin-sdk/define.js';
import { defineProvider } from '@mcp/provider-sdk';
import { ZAIProvider } from '@mcp/indexer/indexer/providers/zai.js';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';
import { parseModelWithMode } from '@mcp/services/providers/shared/model-mode.js';

const ZAI_GENERAL_URL = 'https://api.z.ai/api/paas/v4/';
const ZAI_CODING_URL = 'https://api.z.ai/api/coding/paas/v4/';

/** Resolve the coder baseURL: env override → ::mode suffix → admin base → general. */
function resolveZaiCoderBaseURL(
  _model: string | undefined,
  mode: string | undefined,
  adminBaseURL: string | undefined,
): string {
  if (process.env.ZAI_BASE_URL) return process.env.ZAI_BASE_URL;
  if (mode === 'coding') return ZAI_CODING_URL;
  if (mode === 'general') return ZAI_GENERAL_URL;
  if (adminBaseURL && adminBaseURL.trim()) return adminBaseURL;
  return ZAI_GENERAL_URL;
}

const zai = contributeProvider(
  defineProvider({
    kind: 'zai',
    displayName: 'Z.AI / GLM',
    visual: { icon: 'Sparkles', fg: 'text-violet-500', bg: 'bg-violet-500/15' },
    credKind: 'api-key',
    envVars: ['ZAI_API_KEY'],
    defaultBaseURL: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-5.1',
    defaultModels: [
      'glm-5.1',
      'glm-5-turbo',
      'glm-5',
      'glm-4.7',
      'glm-4.7-flash',
      'glm-4.6',
      'glm-4.5',
      'glm-4.5-air',
      'glm-4.5-flash',
      'glm-4-32b-0414-128k',
    ],
    pricing: {
      'glm-5.1': { inputPer1M: 0.6, outputPer1M: 2.2 },
      'glm-5-turbo': { inputPer1M: 1.2, outputPer1M: 4.0 },
      'glm-5': { inputPer1M: 0.6, outputPer1M: 2.2 },
      'glm-4.7': { inputPer1M: 0.6, outputPer1M: 2.2 },
      'glm-4.7-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
      'glm-4.6': { inputPer1M: 0.6, outputPer1M: 2.2 },
      'glm-4.5': { inputPer1M: 0.6, outputPer1M: 2.2 },
      'glm-4.5-air': { inputPer1M: 0.14, outputPer1M: 0.14 },
      'glm-4.5-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
      'glm-4-32b-0414-128k': { inputPer1M: 0.1, outputPer1M: 0.1 },
    },
    capabilities: { zaiCodingMode: true, supportsThinking: true },
    createIndexer: (creds, model) => {
      const parsed = parseModelWithMode(model);
      return new ZAIProvider(creds.apiKey, parsed.model, creds.baseURL);
    },
    createCoder: (creds, model) => {
      const parsed = parseModelWithMode(model);
      const effectiveModel = parsed.model ?? 'glm-5.1';
      const baseURL = resolveZaiCoderBaseURL(effectiveModel, parsed.mode, creds.baseURL);
      return new OpenAIChatProvider({
        name: 'zai',
        apiKey: creds.apiKey,
        baseURL,
        model: effectiveModel,
        vendor: 'zai',
      });
    },
  }),
);

export default definePlugin({ providers: [zai] });
