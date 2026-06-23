import { defineProvider } from '../types.js';
import { KimiCodeProvider } from '@mcp/indexer/indexer/providers/kimi-code.js';
import { KimiCodeChatProvider } from '@mcp/code-agent/providers/kimi-code.js';
import {
  KIMI_CODE_BASE_URL,
  KIMI_CODE_SEED_MODELS,
  fetchKimiCodeModels,
  refreshIfExpired as refreshKimiCodeToken,
} from '../../services/oauth/kimi-code.js';
import { getStore } from '../shared/store.js';

export const kimiCode = defineProvider({
  kind: 'kimi-code',
  displayName: 'Kimi Code (OAuth)',
  visual: { icon: 'Bot', fg: 'text-cyan-500', bg: 'bg-cyan-500/15' },
  credKind: 'oauth',
  envVars: [],
  defaultBaseURL: KIMI_CODE_BASE_URL,
  defaultModel: 'kimi-k2.6',
  defaultModels: KIMI_CODE_SEED_MODELS.map((m) => m.model_id),
  pricing: {
    'kimi-k2.6': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'kimi-k2.5': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'kimi-k2-thinking': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'kimi-k2-thinking-turbo': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'kimi-k2-turbo-preview': { inputPer1M: 0.00, outputPer1M: 0.00 },
  },
  capabilities: {
    supportsThinking: true,
    supportsVision: true,
  },
  createIndexer: (creds, model) =>
    new KimiCodeProvider(
      creds.apiKey,
      model ?? 'kimi-k2.6',
      creds.baseURL ?? KIMI_CODE_BASE_URL,
      creds.extraHeaders,
    ),
  createCoder: (creds, model) =>
    new KimiCodeChatProvider({
      apiKey: creds.apiKey,
      baseURL: creds.baseURL ?? KIMI_CODE_BASE_URL,
      model: model ?? 'kimi-k2.6',
      defaultHeaders: creds.extraHeaders,
      thinkingMode: readKimiCodeThinkingMode(creds.extra?.thinkingMode),
    }),
  testConnection: async ({ creds, config }) => {
    const headers = creds.extraHeaders;
    const baseURL = creds.baseURL ?? config.base_url;
    try {
      await fetchKimiCodeModels({ baseURL, apiKey: creds.apiKey, headers });
    } catch (e) {
      // A clock-fresh token the server still rejects (401) → force a refresh
      // and retry once, mirroring the prior /test behaviour.
      if (!/HTTP 401/.test((e as Error).message)) throw e;
      const store = getStore();
      const fresh = store ? await refreshKimiCodeToken(store, config.id, { force: true }) : null;
      await fetchKimiCodeModels({ baseURL, apiKey: fresh ?? creds.apiKey, headers });
    }
  },
});

function readKimiCodeThinkingMode(value: unknown): 'auto' | 'enabled' | 'disabled' {
  return value === 'enabled' || value === 'disabled' || value === 'auto'
    ? value
    : 'auto';
}
