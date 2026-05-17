import { defineProvider } from '../types.js';
import { DeepSeekProvider } from '@mcp/indexer/indexer/providers/deepseek.js';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';

export const deepseek = defineProvider({
  kind: 'deepseek',
  displayName: 'DeepSeek',
  credKind: 'api-key',
  envVars: ['DEEPSEEK_API_KEY'],
  defaultBaseURL: 'https://api.deepseek.com/v1',
  defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
  pricing: {
    'deepseek-chat':     { inputPer1M: 0.14, outputPer1M: 0.28 },
    'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19 },
  },
  capabilities: { supportsThinking: true },
  createIndexer: (creds, model) => new DeepSeekProvider(creds.apiKey, model),
  createCoder: (creds, model) =>
    new OpenAIChatProvider({
      name: 'deepseek',
      apiKey: creds.apiKey,
      baseURL: creds.baseURL ?? 'https://api.deepseek.com/v1',
      model: model ?? 'deepseek-chat',
      vendor: 'deepseek',
    }),
});
