import { defineProvider } from '../types.js';
import { OpenAIProvider } from '@mcp/indexer/indexer/providers/openai.js';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';

export const openai = defineProvider({
  kind: 'openai',
  displayName: 'OpenAI',
  visual: { icon: 'Brain', fg: 'text-emerald-500', bg: 'bg-emerald-500/15' },
  credKind: 'api-key',
  envVars: ['OPENAI_API_KEY'],
  defaultModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
  pricing: {
    'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.60 },
    'gpt-4o':      { inputPer1M: 2.50, outputPer1M: 10.00 },
    'gpt-4-turbo': { inputPer1M: 10.00, outputPer1M: 30.00 },
  },
  capabilities: { supportsVision: true },
  createIndexer: (creds, model) =>
    new OpenAIProvider(
      creds.apiKey,
      model,
      creds.baseURL,
      creds.extraHeaders,
      // Cheap default for summary-only analysis. Override via
      // `extra.summary_model` on the provider row when picking a different
      // cheap variant (e.g. "o4-mini" once it lands).
      typeof creds.extra?.summary_model === 'string' ? creds.extra.summary_model : 'gpt-4o-mini',
    ),
  createCoder: (creds, model) =>
    new OpenAIChatProvider({
      name: 'openai',
      apiKey: creds.apiKey,
      baseURL: creds.baseURL,
      model: model ?? 'gpt-4o-mini',
      defaultHeaders: creds.extraHeaders,
    }),
  testConnection: async ({ creds }) => {
    const base = creds.baseURL ?? 'https://api.openai.com/v1';
    const url = base.endsWith('/') ? `${base}models` : `${base}/models`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${creds.apiKey ?? ''}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  },
});
