import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Declarative specs for the OpenAI-compatible built-ins. Metadata mirrors the
 * hand-written `services/.../definitions/*.ts` exactly (the equivalence test
 * asserts it); the per-instance logic becomes `wireOpts` data.
 */

export const openaiSpec: ProviderSpec = {
  kind: 'openai',
  displayName: 'OpenAI',
  visual: { icon: 'Brain', fg: 'text-emerald-500', bg: 'bg-emerald-500/15' },
  credKind: 'api-key',
  envVars: ['OPENAI_API_KEY'],
  defaultModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
  pricing: {
    'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
    'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
    'gpt-4-turbo': { inputPer1M: 10.0, outputPer1M: 30.0 },
  },
  capabilities: { supportsVision: true },
  wire: 'openai-compat',
  wireOpts: { summaryModelDefault: 'gpt-4o-mini' },
  discovery: { from: 'openai-models' },
  test: { from: 'openai-models', fallbackBaseURL: 'https://api.openai.com/v1' },
};

export const deepseekSpec: ProviderSpec = {
  kind: 'deepseek',
  displayName: 'DeepSeek',
  visual: { icon: 'Cpu', fg: 'text-indigo-500', bg: 'bg-indigo-500/15' },
  credKind: 'api-key',
  envVars: ['DEEPSEEK_API_KEY'],
  defaultBaseURL: 'https://api.deepseek.com/v1',
  defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
  pricing: {
    'deepseek-chat': { inputPer1M: 0.14, outputPer1M: 0.28 },
    'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19 },
  },
  capabilities: { supportsThinking: true },
  wire: 'openai-compat',
  wireOpts: { vendor: 'deepseek' },
  discovery: { from: 'openai-models', modelsUrl: 'https://api.deepseek.com/models' },
};

const ZAI_GENERAL_URL = 'https://api.z.ai/api/paas/v4/';
const ZAI_CODING_URL = 'https://api.z.ai/api/coding/paas/v4/';

export const zaiSpec: ProviderSpec = {
  kind: 'zai',
  displayName: 'Z.AI / GLM',
  visual: { icon: 'Sparkles', fg: 'text-violet-500', bg: 'bg-violet-500/15' },
  credKind: 'api-key',
  envVars: ['ZAI_API_KEY'],
  defaultBaseURL: 'https://api.z.ai/api/paas/v4',
  defaultModels: [
    'glm-5.1',
    'glm-5-turbo',
    'glm-5',
    'glm-4.7',
    'glm-4.7-flash',
    'glm-4.6',
    'glm-4.5',
    'glm-4.5-air',
    'glm-4.5-flash',
    'glm-4-32b-0414-128k',
  ],
  pricing: {
    'glm-5.1': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-5-turbo': { inputPer1M: 1.2, outputPer1M: 4.0 },
    'glm-5': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-4.7': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-4.7-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'glm-4.6': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-4.5': { inputPer1M: 0.6, outputPer1M: 2.2 },
    'glm-4.5-air': { inputPer1M: 0.14, outputPer1M: 0.14 },
    'glm-4.5-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'glm-4-32b-0414-128k': { inputPer1M: 0.1, outputPer1M: 0.1 },
    'glm-4-flash': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'glm-4-flash-250414': { inputPer1M: 0.0, outputPer1M: 0.0 },
    'glm-4-air': { inputPer1M: 0.14, outputPer1M: 0.14 },
    'glm-4-airx': { inputPer1M: 1.4, outputPer1M: 1.4 },
    'glm-4': { inputPer1M: 1.4, outputPer1M: 1.4 },
  },
  capabilities: { zaiCodingMode: true, supportsThinking: true },
  wire: 'openai-compat',
  wireOpts: {
    vendor: 'zai',
    modelModes: {
      map: { coding: { baseURL: ZAI_CODING_URL }, general: { baseURL: ZAI_GENERAL_URL } },
      envOverride: 'ZAI_BASE_URL',
      defaultModeKey: 'zai_mode',
    },
  },
  discovery: {
    from: 'openai-models',
    modelsUrl: 'https://api.z.ai/api/paas/v4/models',
    supportsModes: ['normal', 'coding'],
  },
  config: {
    fields: [
      {
        key: 'zai_mode',
        type: 'select',
        label: 'Plan mode',
        storeIn: 'extra',
        options: [
          { value: 'normal', label: 'Normal (general endpoint)' },
          { value: 'coding', label: 'Coding (GLM Coding Plan endpoint)' },
        ],
        default: 'normal',
        helpText:
          "Default Z.AI endpoint + the plan's models. A model suffix like 'glm-4.6::coding' still overrides per request.",
      },
    ],
  },
};

const CF_BASE_URL_TEMPLATE = 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1';

export const cloudflareSpec: ProviderSpec = {
  kind: 'cloudflare',
  displayName: 'Cloudflare Workers AI',
  visual: { icon: 'Layers', fg: 'text-orange-600', bg: 'bg-orange-600/15' },
  credKind: 'api-key',
  envVars: ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'],
  defaultBaseURL: CF_BASE_URL_TEMPLATE,
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
    '@cf/meta/llama-3.1-8b-instruct-fp8': { inputPer1M: 0.152, outputPer1M: 0.287 },
    '@cf/meta/llama-3.1-8b-instruct': { inputPer1M: 0.282, outputPer1M: 0.827 },
    '@cf/mistral/mistral-7b-instruct-v0.1': { inputPer1M: 0.11, outputPer1M: 0.19 },
    '@cf/mistralai/mistral-small-3.1-24b-instruct': { inputPer1M: 0.351, outputPer1M: 0.555 },
    '@cf/google/gemma-4-26b-a4b-it': { inputPer1M: 0.1, outputPer1M: 0.3 },
    '@cf/zai-org/glm-4.7-flash': { inputPer1M: 0.06, outputPer1M: 0.4 },
    '@cf/moonshotai/kimi-k2.6': { inputPer1M: 0.95, outputPer1M: 4.0 },
    '@cf/moonshotai/kimi-k2.5': { inputPer1M: 0.6, outputPer1M: 3.0 },
    '@cf/nvidia/nemotron-3-120b-a12b': { inputPer1M: 0.5, outputPer1M: 1.5 },
    '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': { inputPer1M: 0.497, outputPer1M: 4.881 },
    '@cf/ibm-granite/granite-4.0-h-micro': { inputPer1M: 0.017, outputPer1M: 0.112 },
    '@cf/baai/bge-m3': { inputPer1M: 0.012, outputPer1M: 0 },
    '@cf/qwen/qwen3-embedding-0.6b': { inputPer1M: 0.012, outputPer1M: 0 },
    '@cf/baai/bge-large-en-v1.5': { inputPer1M: 0.204, outputPer1M: 0 },
    '@cf/baai/bge-base-en-v1.5': { inputPer1M: 0.067, outputPer1M: 0 },
    '@cf/baai/bge-small-en-v1.5': { inputPer1M: 0.02, outputPer1M: 0 },
  },
  wire: 'openai-compat',
  wireOpts: {
    baseUrlTemplate: CF_BASE_URL_TEMPLATE,
    baseUrlVars: {
      account_id: {
        sources: [
          { from: 'extra', key: 'account_id' },
          { from: 'env', key: 'CLOUDFLARE_ACCOUNT_ID' },
          { from: 'env', key: 'CF_ACCOUNT_ID' },
        ],
        required: true,
        errorMessage:
          'Cloudflare provider requires an Account ID. Set extra.account_id on ' +
          'the provider row, or export CLOUDFLARE_ACCOUNT_ID.',
      },
    },
    indexerDefaultModel: '@cf/meta/llama-3.1-8b-instruct-fp8',
  },
  discovery: {
    from: 'cloudflare-models',
    accountIdFrom: {
      sources: [
        { from: 'extra', key: 'account_id' },
        { from: 'env', key: 'CLOUDFLARE_ACCOUNT_ID' },
        { from: 'env', key: 'CF_ACCOUNT_ID' },
      ],
      required: true,
    },
  },
  config: {
    fields: [
      {
        key: 'account_id',
        type: 'text',
        label: 'Account ID',
        storeIn: 'extra',
        placeholder: '32-character Cloudflare account id',
        helpText: 'From your Cloudflare dashboard. Fills {account_id} in the base URL.',
      },
    ],
  },
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const openrouterSpec: ProviderSpec = {
  kind: 'openrouter',
  displayName: 'OpenRouter',
  visual: { icon: 'Network', fg: 'text-pink-500', bg: 'bg-pink-500/15' },
  credKind: 'api-key',
  envVars: ['OPENROUTER_API_KEY'],
  defaultBaseURL: OPENROUTER_BASE_URL,
  defaultModels: [
    '~openai/gpt-latest',
    'openrouter/auto',
    'openai/gpt-4o-mini',
    'anthropic/claude-sonnet-4.5',
    'google/gemini-2.5-pro',
    'deepseek/deepseek-chat',
  ],
  pricing: {},
  capabilities: { supportsVision: true, supportsThinking: true },
  wire: 'openai-compat',
  wireOpts: {
    vendor: 'openrouter',
    indexerDefaultModel: '~openai/gpt-latest',
    headerSources: [
      {
        header: 'HTTP-Referer',
        sources: [
          { from: 'extra', key: 'http_referer' },
          { from: 'extra', key: 'referer' },
          { from: 'extra', key: 'site_url' },
          { from: 'env', key: 'OPENROUTER_HTTP_REFERER' },
          { from: 'env', key: 'OPENROUTER_SITE_URL' },
        ],
      },
      {
        header: 'X-OpenRouter-Title',
        sources: [
          { from: 'extra', key: 'app_title' },
          { from: 'extra', key: 'title' },
          { from: 'env', key: 'OPENROUTER_APP_TITLE' },
        ],
      },
    ],
  },
  discovery: { from: 'openrouter-models' },
  test: { from: 'openai-models' },
  config: {
    fields: [
      {
        key: 'http_referer',
        type: 'text',
        label: 'HTTP-Referer',
        storeIn: 'extra',
        optional: true,
        advanced: true,
        placeholder: 'https://yourapp.example',
        helpText: 'Optional attribution sent to OpenRouter.',
      },
      {
        key: 'app_title',
        type: 'text',
        label: 'App title',
        storeIn: 'extra',
        optional: true,
        advanced: true,
        placeholder: 'My App',
      },
    ],
  },
};

export const OPENAI_COMPAT_SPECS: ProviderSpec[] = [
  openaiSpec,
  deepseekSpec,
  zaiSpec,
  cloudflareSpec,
  openrouterSpec,
];
