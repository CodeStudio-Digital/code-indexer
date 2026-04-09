import { defineProvider } from '../types.js';
import { ChatGPTProvider } from '../../indexer/providers/chatgpt.js';
import { ChatGPTCodexProvider } from '../../coder/providers/chatgpt.js';

/**
 * ChatGPT (Codex PKCE OAuth). credKind='oauth' — `resolveCreds` dispatches
 * to `resolveChatGPTCreds` which refreshes the access token, extracts the
 * chatgpt_account_id from the id_token JWT, and exposes both via
 * ResolvedCreds.
 */
export const chatgpt = defineProvider({
  kind: 'chatgpt',
  displayName: 'ChatGPT (Codex OAuth)',
  credKind: 'oauth',
  envVars: [],
  defaultModels: ['gpt-5.3-codex', 'gpt-5-codex', 'gpt-4o'],
  pricing: {
    'gpt-5.3-codex': { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gpt-5-codex':   { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gpt-4o':        { inputPer1M: 2.50, outputPer1M: 10.00 },
  },
  createIndexer: (creds, model) =>
    new ChatGPTProvider({
      apiKey: creds.apiKey ?? '',
      model,
      baseURL: creds.baseURL ?? 'https://chatgpt.com/backend-api/codex',
      accountId: (creds.extra?.accountId as string | null | undefined) ?? null,
    }),
  createCoder: (creds, model) =>
    new ChatGPTCodexProvider({
      apiKey: creds.apiKey ?? '',
      baseURL: creds.baseURL ?? 'https://chatgpt.com/backend-api/codex',
      accountId: (creds.extra?.accountId as string | null | undefined) ?? null,
      model: model ?? 'gpt-5.3-codex',
    }),
});
