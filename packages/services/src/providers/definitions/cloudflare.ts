import { defineProvider } from '../types.js';
import { OpenAIProvider } from '@mcp/indexer/indexer/providers/openai.js';
import { OpenAIChatProvider } from '@mcp/code-agent/providers/openai.js';

const BASE_URL_TEMPLATE = 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1';

function readAccountId(extra: Record<string, unknown> | undefined): string {
  const raw = extra?.account_id;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  const env = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  if (env && env.length > 0) return env;
  throw new Error(
    'Cloudflare provider requires an Account ID. Set extra.account_id on ' +
    'the provider row, or export CLOUDFLARE_ACCOUNT_ID.',
  );
}

function buildBaseURL(extra: Record<string, unknown> | undefined): string {
  return BASE_URL_TEMPLATE.replace('{account_id}', readAccountId(extra));
}

/**
 * Cloudflare Workers AI via the OpenAI-compatible REST endpoint.
 *
 * Account ID lives in `provider_configs.extra.account_id` (or env
 * CLOUDFLARE_ACCOUNT_ID) — substituted into the baseURL at construction
 * time. API token goes in `api_key` like any other api-key shape. To
 * route through AI Gateway later, swap `BASE_URL_TEMPLATE` to
 *   `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/workers-ai/v1`
 * and read `extra.gateway_id` the same way.
 *
 * Pricing is derived from the public neurons-per-million-tokens table
 * ($0.011 / 1k neurons), so it stays comparable with the other shapes.
 */
export const cloudflare = defineProvider({
  kind: 'cloudflare',
  displayName: 'Cloudflare Workers AI',
  credKind: 'api-key',
  envVars: ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'],
  defaultBaseURL: BASE_URL_TEMPLATE,
  defaultModels: [
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/meta/llama-3.1-8b-instruct-fp8',
    '@cf/google/gemma-4-26b-a4b-it',
    '@cf/zai-org/glm-4.7-flash',
    '@cf/moonshotai/kimi-k2.6',
    '@cf/mistral/mistral-7b-instruct-v0.1',
    '@cf/baai/bge-m3',
    '@cf/qwen/qwen3-embedding-0.6b',
  ],
  pricing: {
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { inputPer1M: 0.293, outputPer1M: 2.253 },
    '@cf/meta/llama-3.1-70b-instruct-fp8-fast': { inputPer1M: 0.293, outputPer1M: 2.253 },
    '@cf/meta/llama-3.1-8b-instruct-fp8':       { inputPer1M: 0.152, outputPer1M: 0.287 },
    '@cf/meta/llama-3.1-8b-instruct':           { inputPer1M: 0.282, outputPer1M: 0.827 },
    '@cf/mistral/mistral-7b-instruct-v0.1':     { inputPer1M: 0.110, outputPer1M: 0.190 },
    '@cf/mistralai/mistral-small-3.1-24b-instruct': { inputPer1M: 0.351, outputPer1M: 0.555 },
    '@cf/google/gemma-4-26b-a4b-it':            { inputPer1M: 0.100, outputPer1M: 0.300 },
    '@cf/zai-org/glm-4.7-flash':                { inputPer1M: 0.060, outputPer1M: 0.400 },
    '@cf/moonshotai/kimi-k2.6':                 { inputPer1M: 0.950, outputPer1M: 4.000 },
    '@cf/moonshotai/kimi-k2.5':                 { inputPer1M: 0.600, outputPer1M: 3.000 },
    '@cf/nvidia/nemotron-3-120b-a12b':          { inputPer1M: 0.500, outputPer1M: 1.500 },
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { inputPer1M: 0.497, outputPer1M: 4.881 },
    '@cf/ibm-granite/granite-4.0-h-micro':      { inputPer1M: 0.017, outputPer1M: 0.112 },
    '@cf/baai/bge-m3':                          { inputPer1M: 0.012, outputPer1M: 0 },
    '@cf/qwen/qwen3-embedding-0.6b':            { inputPer1M: 0.012, outputPer1M: 0 },
    '@cf/baai/bge-large-en-v1.5':               { inputPer1M: 0.204, outputPer1M: 0 },
    '@cf/baai/bge-base-en-v1.5':                { inputPer1M: 0.067, outputPer1M: 0 },
    '@cf/baai/bge-small-en-v1.5':               { inputPer1M: 0.020, outputPer1M: 0 },
  },
  createIndexer: (creds, model) =>
    new OpenAIProvider(
      creds.apiKey,
      model ?? '@cf/meta/llama-3.1-8b-instruct-fp8',
      buildBaseURL(creds.extra),
    ),
  createCoder: (creds, model) =>
    new OpenAIChatProvider({
      name: 'cloudflare',
      apiKey: creds.apiKey,
      baseURL: buildBaseURL(creds.extra),
      model: model ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    }),
});
