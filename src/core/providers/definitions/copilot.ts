import { defineProvider } from '../types.js';
import { OpenAIProvider } from '../../indexer/providers/openai.js';
import { OpenAIChatProvider } from '../../coder/providers/openai.js';

/**
 * GitHub Copilot (individual + Enterprise) — OAuth Device Flow.
 *
 * Copilot speaks an OpenAI-compatible chat-completions schema but requires
 * the editor header set (Editor-Version, Copilot-Integration-Id, ...) on
 * every request. The 25-minute access token is refreshed by
 * `resolveCopilotCreds` BEFORE the factory instantiates this provider,
 * so by the time we reach createIndexer/createCoder the creds already
 * contain: `apiKey` (fresh token), `baseURL` (instance or enterprise),
 * `extraHeaders` (editor headers without Authorization).
 *
 * Enterprise works automatically because admin UI writes the enterprise
 * API endpoint into `oauth_tokens.extra.endpoints.api`, which the resolver
 * propagates into `creds.baseURL`.
 */
export const copilot = defineProvider({
  kind: 'copilot',
  displayName: 'GitHub Copilot',
  credKind: 'oauth',
  envVars: [],
  defaultModels: ['gpt-4o', 'gpt-4o-mini', 'claude-3.5-sonnet', 'o1-mini'],
  pricing: {
    // Copilot is billed via the subscription; the indexer has no marginal cost.
    'gpt-4o':             { inputPer1M: 0.00, outputPer1M: 0.00 },
    'gpt-4o-mini':        { inputPer1M: 0.00, outputPer1M: 0.00 },
    'claude-3.5-sonnet':  { inputPer1M: 0.00, outputPer1M: 0.00 },
    'o1-mini':            { inputPer1M: 0.00, outputPer1M: 0.00 },
  },
  createIndexer: (creds, model) =>
    new OpenAIProvider(creds.apiKey, model ?? 'gpt-4o', creds.baseURL, creds.extraHeaders),
  createCoder: (creds, model) =>
    new OpenAIChatProvider({
      name: 'copilot',
      apiKey: creds.apiKey,
      baseURL: creds.baseURL,
      model: model ?? 'gpt-4o',
      defaultHeaders: creds.extraHeaders,
    }),
});
