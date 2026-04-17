import { defineProvider } from '../types.js';
import { ZAIProvider } from '../../indexer/providers/zai.js';
import { OpenAIChatProvider } from '../../coder/providers/openai.js';
import { parseModelWithMode } from '../shared/model-mode.js';

/**
 * Z.AI / Zhipu GLM. Uses OpenAI-compat wire protocol for both indexer
 * and coder. The `coding` capability flag signals to the dashboard that
 * the model picker should show a "::coding" mode toggle.
 *
 * Mode encoding: the dashboard sends `model` as `"glm-5.1::coding"` when
 * the coding variant is selected. `createCoder` parses that suffix and
 * picks between the two Z.AI base URLs (general vs coding).
 */

/** Models that implicitly route through the coding edge even without ::mode. */
const ZAI_CODING_MODELS: ReadonlySet<string> = new Set([
  'glm-5.1', 'glm-5-turbo', 'glm-4-plus', 'codegeex-4', 'codegeex-4-flash',
]);
const ZAI_GENERAL_URL = 'https://api.z.ai/api/paas/v4/';
const ZAI_CODING_URL = 'https://api.z.ai/api/coding/paas/v4/';

/**
 * Resolve the coder baseURL. Matches the legacy factory semantics exactly:
 *   1. `process.env.ZAI_BASE_URL` always wins (test override).
 *   2. Otherwise, pick between ZAI_CODING_URL and ZAI_GENERAL_URL based on
 *      explicit `::mode` suffix first, then heuristic on the model name.
 *
 * Intentionally ignores `creds.baseURL` (i.e. `cfg.base_url` from the
 * ProviderStore) because the seed default is the general URL and the
 * heuristic must override it so coding-capable models land on the coding
 * edge. Admin overrides for ZAI should go through `ZAI_BASE_URL`.
 */
function resolveZaiCoderBaseURL(model: string | undefined, mode: string | undefined): string {
  if (process.env.ZAI_BASE_URL) return process.env.ZAI_BASE_URL;
  const wantsCoding = mode === 'coding' || (!mode && !!model && ZAI_CODING_MODELS.has(model));
  return wantsCoding ? ZAI_CODING_URL : ZAI_GENERAL_URL;
}

export const zai = defineProvider({
  kind: 'zai',
  displayName: 'Z.AI / GLM',
  credKind: 'api-key',
  envVars: ['ZAI_API_KEY'],
  defaultBaseURL: 'https://api.z.ai/api/paas/v4',
  defaultModels: [
    'glm-5.1',
    'glm-5-turbo',
    'glm-4.7-flash',
    'glm-4.5-flash',
    'glm-4-32b-0414-128k',
    'glm-4-air',
    'glm-4-airx',
  ],
  pricing: {
    'glm-5.1':              { inputPer1M: 0.60, outputPer1M: 2.20 },
    'glm-5-turbo':          { inputPer1M: 1.20, outputPer1M: 4.00 },
    'glm-4.7-flash':        { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4.5-flash':        { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4-32b-0414-128k':  { inputPer1M: 0.10, outputPer1M: 0.10 },
    'glm-4-flash':          { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4-flash-250414':   { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4-air':            { inputPer1M: 0.14, outputPer1M: 0.14 },
    'glm-4-airx':           { inputPer1M: 1.40, outputPer1M: 1.40 },
    'glm-4':                { inputPer1M: 1.40, outputPer1M: 1.40 },
  },
  capabilities: { zaiCodingMode: true },
  createIndexer: (creds, model) => {
    // Indexer path matches legacy exactly: strip any "::mode" suffix, respect
    // cfg.base_url if present (seed default is the general URL, which is
    // always correct for single-shot analysis).
    const parsed = parseModelWithMode(model);
    return new ZAIProvider(creds.apiKey, parsed.model, creds.baseURL);
  },
  createCoder: (creds, model) => {
    const parsed = parseModelWithMode(model);
    const effectiveModel = parsed.model ?? 'glm-5.1';
    const baseURL = resolveZaiCoderBaseURL(effectiveModel, parsed.mode);
    return new OpenAIChatProvider({
      name: 'zai',
      apiKey: creds.apiKey,
      baseURL,
      model: effectiveModel,
      vendor: 'zai',
    });
  },
});
