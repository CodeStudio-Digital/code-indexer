import { defineProvider } from '../types.js';
import { ZAIProvider } from '../../indexer/providers/zai.js';
import { OpenAIChatProvider } from '../../coder/providers/openai.js';

/**
 * Z.AI / Zhipu GLM. Uses OpenAI-compat wire protocol for both indexer
 * and coder. The `coding` capability flag signals to the dashboard that
 * the model picker should show a "::coding" mode toggle; the encoding of
 * that suffix is handled by the coder factory before instantiation.
 */
export const zai = defineProvider({
  kind: 'zai',
  displayName: 'Z.AI / GLM',
  credKind: 'api-key',
  envVars: ['ZAI_API_KEY'],
  defaultBaseURL: 'https://api.z.ai/api/paas/v4',
  defaultModels: [
    'glm-4.7-flash',
    'glm-4.5-flash',
    'glm-4-32b-0414-128k',
    'glm-4-air',
    'glm-4-airx',
    'glm-5-turbo',
  ],
  pricing: {
    'glm-4.7-flash':        { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4.5-flash':        { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4-32b-0414-128k':  { inputPer1M: 0.10, outputPer1M: 0.10 },
    'glm-4-flash':          { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4-flash-250414':   { inputPer1M: 0.00, outputPer1M: 0.00 },
    'glm-4-air':            { inputPer1M: 0.14, outputPer1M: 0.14 },
    'glm-4-airx':           { inputPer1M: 1.40, outputPer1M: 1.40 },
    'glm-4':                { inputPer1M: 1.40, outputPer1M: 1.40 },
    'glm-5-turbo':          { inputPer1M: 1.20, outputPer1M: 4.00 },
  },
  capabilities: { zaiCodingMode: true },
  createIndexer: (creds, model) =>
    new ZAIProvider(creds.apiKey, model, creds.baseURL),
  createCoder: (creds, model) =>
    new OpenAIChatProvider({
      name: 'zai',
      apiKey: creds.apiKey,
      baseURL: creds.baseURL ?? 'https://api.z.ai/api/paas/v4',
      model: model ?? 'glm-5-turbo',
    }),
});
