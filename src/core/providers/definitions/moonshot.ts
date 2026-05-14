import { defineProvider } from '../types.js';
import { KimiCodeProvider } from '../../indexer/providers/kimi-code.js';
import { KimiCodeChatProvider } from '../../coder/providers/kimi-code.js';

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_MODEL = 'kimi-k2-0711-preview';

/**
 * Moonshot AI Open Platform (api-key auth).
 *
 * Distinct from `kimi-code` (OAuth via api.kimi.com/coding/v1). Same wire
 * protocol, same adapters — only auth shape and base URL differ. Three
 * known endpoints, picked via `cfg.base_url`:
 *   - https://api.moonshot.ai/v1 (global, default)
 *   - https://api.moonshot.cn/v1 (China region)
 *   - https://api.kimi.com/coding/v1 (Kimi Code with a static key)
 *
 * Reuses KimiCodeChatProvider so thinking-mode handling, tool-schema
 * normalization, and reasoning-content streaming all work identically.
 * `extra.kimi_code_thinking_mode` (set via the same admin select used
 * for kimi-code) flows through `creds.extra.thinkingMode` — see
 * provider-store routing below.
 */
export const moonshot = defineProvider({
  kind: 'moonshot',
  displayName: 'Moonshot AI (API key)',
  credKind: 'api-key',
  envVars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  defaultBaseURL: DEFAULT_BASE_URL,
  defaultModels: [
    'kimi-k2-0711-preview',
    'kimi-k2-turbo-preview',
    'kimi-k2-thinking-turbo',
    'kimi-latest',
    'moonshot-v1-auto',
    'moonshot-v1-128k',
    'moonshot-v1-32k',
    'moonshot-v1-8k',
  ],
  pricing: {
    'kimi-k2-0711-preview':    { inputPer1M: 0.60, outputPer1M: 2.50 },
    'kimi-k2-turbo-preview':   { inputPer1M: 0.60, outputPer1M: 2.50 },
    'kimi-k2-thinking-turbo':  { inputPer1M: 0.60, outputPer1M: 2.50 },
    'kimi-latest':             { inputPer1M: 0.60, outputPer1M: 2.50 },
    'moonshot-v1-8k':          { inputPer1M: 0.20, outputPer1M: 2.00 },
    'moonshot-v1-32k':         { inputPer1M: 1.00, outputPer1M: 3.00 },
    'moonshot-v1-128k':        { inputPer1M: 2.00, outputPer1M: 5.00 },
    'moonshot-v1-auto':        { inputPer1M: 1.00, outputPer1M: 3.00 },
  },
  capabilities: {
    supportsThinking: true,
    supportsVision: true,
  },
  createIndexer: (creds, model) =>
    new KimiCodeProvider(
      creds.apiKey,
      model ?? DEFAULT_MODEL,
      creds.baseURL ?? DEFAULT_BASE_URL,
      creds.extraHeaders,
    ),
  createCoder: (creds, model) =>
    new KimiCodeChatProvider({
      apiKey: creds.apiKey,
      baseURL: creds.baseURL ?? DEFAULT_BASE_URL,
      model: model ?? DEFAULT_MODEL,
      defaultHeaders: creds.extraHeaders,
      thinkingMode: readThinkingMode(creds.extra?.kimi_code_thinking_mode),
    }),
});

function readThinkingMode(value: unknown): 'auto' | 'enabled' | 'disabled' {
  return value === 'enabled' || value === 'disabled' || value === 'auto'
    ? value
    : 'auto';
}
