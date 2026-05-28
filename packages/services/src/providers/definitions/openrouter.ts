import { defineProvider } from '../types.js';
import { OpenAIProvider } from '@mcp/indexer/indexer/providers/openai.js';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = '~openai/gpt-latest';

function buildOpenRouterHeaders(extra: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const referer = readString(extra?.http_referer)
    ?? readString(extra?.referer)
    ?? readString(extra?.site_url)
    ?? process.env.OPENROUTER_HTTP_REFERER
    ?? process.env.OPENROUTER_SITE_URL;
  const title = readString(extra?.app_title)
    ?? readString(extra?.title)
    ?? process.env.OPENROUTER_APP_TITLE;

  const headers: Record<string, string> = {};
  if (referer) headers['HTTP-Referer'] = referer;
  if (title) headers['X-OpenRouter-Title'] = title;
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * OpenRouter exposes an OpenAI-compatible `/chat/completions` API and a rich
 * `/models` catalog. Model ids are OpenRouter slugs (for example
 * `anthropic/claude-sonnet-4.5` or the `~openai/gpt-latest` alias), so keep
 * summary analysis on the selected model unless the operator explicitly pins
 * `extra.summary_model`.
 */
export const openrouter = defineProvider({
  kind: 'openrouter',
  displayName: 'OpenRouter',
  credKind: 'api-key',
  envVars: ['OPENROUTER_API_KEY'],
  defaultBaseURL: DEFAULT_BASE_URL,
  defaultModels: [
    '~openai/gpt-latest',
    'openrouter/auto',
    'openai/gpt-4o-mini',
    'anthropic/claude-sonnet-4.5',
    'google/gemini-2.5-pro',
    'deepseek/deepseek-chat',
  ],
  pricing: {},
  capabilities: {
    supportsVision: true,
    supportsThinking: true,
  },
  createIndexer: (creds, model) =>
    new OpenAIProvider(
      creds.apiKey,
      model ?? DEFAULT_MODEL,
      creds.baseURL ?? DEFAULT_BASE_URL,
      buildOpenRouterHeaders(creds.extra),
      readString(creds.extra?.summary_model),
    ),
  createCoder: (creds, model) =>
    new OpenAIChatProvider({
      name: 'openrouter',
      apiKey: creds.apiKey,
      baseURL: creds.baseURL ?? DEFAULT_BASE_URL,
      model: model ?? DEFAULT_MODEL,
      defaultHeaders: buildOpenRouterHeaders(creds.extra),
      vendor: 'openrouter',
    }),
});
