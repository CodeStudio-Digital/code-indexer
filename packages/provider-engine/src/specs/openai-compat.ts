import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Declarative specs for the OpenAI-compatible built-ins. Provider-specific
 * per-instance logic is represented as `wireOpts` data.
 */

export const openaiSpec: ProviderSpec = {
  kind: 'openai',
  displayName: 'OpenAI',
  visual: { icon: 'Brain', fg: 'text-emerald-500', bg: 'bg-emerald-500/15' },
  credKind: 'api-key',
  envVars: ['OPENAI_API_KEY'],
  defaultBaseURL: 'https://api.openai.com/v1',
  defaultModel: 'gpt-5.6-sol',
  defaultModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
  pricing: {
    'gpt-5.6-sol': { inputPer1M: 5.0, outputPer1M: 30.0 },
    'gpt-5.6-terra': { inputPer1M: 2.0, outputPer1M: 12.0 },
    'gpt-5.6-luna': { inputPer1M: 0.2, outputPer1M: 1.2 },
    // Retain historical rows so persisted sessions keep accurate cost data.
    'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
    'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10.0 },
    'gpt-4-turbo': { inputPer1M: 10.0, outputPer1M: 30.0 },
  },
  capabilities: {
    supportsThinking: true,
    supportsVision: true,
    supportsImageGen: true,
    fileInput: 'native',
  },
  semantic: {
    embedding: {
      protocol: 'openai-embeddings',
      defaultModels: ['text-embedding-3-small', 'text-embedding-3-large'],
      modelPatterns: ['embedding', 'embed'],
    },
  },
  wire: 'openai-compat',
  wireOpts: {
    vendor: 'openai',
    responsesApi: true,
    responsesReasoningFromThinking: true,
    responsesReasoningSummaryModels: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    summaryModelDefault: 'gpt-5.6-luna',
  },
  discovery: { from: 'openai-models' },
  test: { from: 'openai-models', fallbackBaseURL: 'https://api.openai.com/v1' },
  models: {
    'gpt-5.6-sol': {
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'medium',
      applyPatchToolType: 'freeform',
    },
    'gpt-5.6-terra': {
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'medium',
      applyPatchToolType: 'freeform',
    },
    'gpt-5.6-luna': {
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'medium',
      applyPatchToolType: 'freeform',
    },
  },
};

export const deepseekSpec: ProviderSpec = {
  kind: 'deepseek',
  displayName: 'DeepSeek',
  visual: { icon: 'Cpu', fg: 'text-indigo-500', bg: 'bg-indigo-500/15' },
  credKind: 'api-key',
  envVars: ['DEEPSEEK_API_KEY'],
  defaultBaseURL: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-v4-flash',
  defaultModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  pricing: {
    'deepseek-v4-flash': { inputPer1M: 0.14, outputPer1M: 0.28 },
    'deepseek-v4-pro': { inputPer1M: 0.435, outputPer1M: 0.87 },
    'deepseek-chat': { inputPer1M: 0.14, outputPer1M: 0.28 },
    'deepseek-reasoner': { inputPer1M: 0.55, outputPer1M: 2.19 },
  },
  capabilities: { supportsThinking: true },
  wire: 'openai-compat',
  wireOpts: { vendor: 'deepseek' },
  discovery: { from: 'openai-models', modelsUrl: 'https://api.deepseek.com/models' },
  models: {
    'deepseek-v4-flash': {
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      canReason: true,
      supportedReasoningLevels: ['high', 'max'],
      defaultReasoningLevel: 'high',
    },
    'deepseek-v4-pro': {
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      canReason: true,
      supportedReasoningLevels: ['high', 'max'],
      defaultReasoningLevel: 'high',
    },
  },
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
  defaultModel: '@cf/moonshotai/kimi-k2.7-code',
  defaultModels: [
    '@cf/moonshotai/kimi-k2.7-code',
    '@cf/zai-org/glm-5.2',
    '@cf/openai/gpt-oss-120b',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/google/gemma-4-26b-a4b-it',
    '@cf/zai-org/glm-4.7-flash',
    '@cf/baai/bge-m3',
    '@cf/qwen/qwen3-embedding-0.6b',
  ],
  pricing: {
    '@cf/moonshotai/kimi-k2.7-code': { inputPer1M: 0.95, outputPer1M: 4.0 },
    '@cf/zai-org/glm-5.2': { inputPer1M: 1.4, outputPer1M: 4.4 },
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
  semantic: {
    embedding: {
      protocol: 'cloudflare',
      defaultModels: ['@cf/baai/bge-m3', '@cf/qwen/qwen3-embedding-0.6b'],
      modelPatterns: ['embedding', 'bge-m3', 'qwen3-embedding'],
    },
    rerank: {
      protocol: 'cloudflare',
      defaultModels: ['@cf/baai/bge-reranker-base'],
      modelPatterns: ['rerank'],
    },
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
  models: {
    '@cf/moonshotai/kimi-k2.7-code': {
      contextWindow: 262_144,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: null,
      defaultReasoningLevel: null,
      inputModalities: ['text', 'image'],
    },
    '@cf/zai-org/glm-5.2': {
      contextWindow: 262_144,
      canReason: true,
      supportedReasoningLevels: null,
      defaultReasoningLevel: null,
      inputModalities: ['text'],
    },
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
    'openai/gpt-5.6-sol',
    'anthropic/claude-sonnet-5',
    'google/gemini-3.6-flash',
    'deepseek/deepseek-v4-flash',
  ],
  semantic: {
    embedding: {
      protocol: 'openai-embeddings',
      modelPatterns: ['embedding', 'embed'],
    },
    rerank: {
      protocol: 'cohere-rerank',
      defaultModels: ['nvidia/llama-nemotron-rerank-vl-1b-v2:free'],
      modelPatterns: ['rerank'],
    },
  },
  pricing: {},
  capabilities: { supportsVision: true, supportsThinking: true, fileInput: 'native' },
  wire: 'openai-compat',
  wireOpts: {
    vendor: 'openrouter',
    indexerDefaultModel: '~openai/gpt-latest',
    headerSources: [
      {
        header: 'HTTP-Referer',
        defaultValue: 'https://codestudio.digital',
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
        defaultValue: 'MegaBrain',
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

/**
 * Sakana AI Fugu — a stateless OpenAI-compatible Responses provider. Sakana
 * recommends Responses for reasoning + tool-call management. The bare /models
 * endpoint returns only ids, so the documented reasoning levels, 1M context and
 * freeform apply_patch support are gap-filled from this declarative catalog.
 */
export const fuguSpec: ProviderSpec = {
  kind: 'fugu',
  displayName: 'Sakana AI Fugu',
  visual: { icon: 'Sparkles', fg: 'text-sky-500', bg: 'bg-sky-500/15' },
  credKind: 'api-key',
  envVars: ['FUGU_API_KEY'],
  defaultBaseURL: 'https://api.sakana.ai/v1',
  defaultModels: [
    'fugu',
    'fugu-ultra',
    'fugu-ultra-v1.1',
    'fugu-ultra-v1.0',
    'fugu-ultra-20260615',
    'fugu-cyber',
    'fugu-cyber-v1.0',
  ],
  defaultModel: 'fugu',
  pricing: {
    // Standard tier only: >272K and cached-input prices are not representable
    // in PricingEntry. Base `fugu` has route-dependent pricing, so it is omitted.
    'fugu-ultra': { inputPer1M: 5.0, outputPer1M: 30.0 },
    'fugu-ultra-v1.1': { inputPer1M: 5.0, outputPer1M: 30.0 },
    'fugu-ultra-v1.0': { inputPer1M: 5.0, outputPer1M: 30.0 },
    'fugu-ultra-20260615': { inputPer1M: 5.0, outputPer1M: 30.0 },
    'fugu-cyber': { inputPer1M: 6.0, outputPer1M: 36.0 },
    'fugu-cyber-v1.0': { inputPer1M: 6.0, outputPer1M: 36.0 },
  },
  capabilities: { supportsThinking: false, supportsVision: true },
  wire: 'openai-compat',
  wireOpts: {
    vendor: 'fugu',
    responsesApi: true,
    responsesStateless: true,
    responsesReasoningSummaryModels: [
      'fugu',
      'fugu-ultra',
      'fugu-ultra-v1.1',
      'fugu-ultra-v1.0',
      'fugu-ultra-20260615',
      'fugu-cyber',
      'fugu-cyber-v1.0',
    ],
    responsesIncludeOrchestrationUsage: true,
    summaryModelDefault: 'fugu',
  },
  discovery: { from: 'openai-models' },
  test: { from: 'openai-models', fallbackBaseURL: 'https://api.sakana.ai/v1' },
  models: {
    fugu: {
      supportedReasoningLevels: ['high', 'xhigh'],
      defaultReasoningLevel: 'high',
      contextWindow: 1_000_000,
      applyPatchToolType: 'freeform',
    },
    'fugu-ultra': {
      supportedReasoningLevels: ['high', 'xhigh', 'max'],
      defaultReasoningLevel: 'xhigh',
      contextWindow: 1_000_000,
      applyPatchToolType: 'freeform',
    },
    'fugu-ultra-v1.1': {
      supportedReasoningLevels: ['high', 'xhigh', 'max'],
      defaultReasoningLevel: 'xhigh',
      contextWindow: 1_000_000,
      applyPatchToolType: 'freeform',
    },
    'fugu-ultra-v1.0': {
      supportedReasoningLevels: ['high', 'xhigh'],
      defaultReasoningLevel: 'xhigh',
      contextWindow: 1_000_000,
      applyPatchToolType: 'freeform',
    },
    'fugu-ultra-20260615': {
      supportedReasoningLevels: ['high', 'xhigh'],
      defaultReasoningLevel: 'xhigh',
      contextWindow: 1_000_000,
      applyPatchToolType: 'freeform',
    },
    'fugu-cyber': {
      supportedReasoningLevels: ['high', 'xhigh'],
      defaultReasoningLevel: 'high',
      contextWindow: 1_000_000,
      applyPatchToolType: 'freeform',
    },
    'fugu-cyber-v1.0': {
      supportedReasoningLevels: ['high', 'xhigh'],
      defaultReasoningLevel: 'high',
      contextWindow: 1_000_000,
      applyPatchToolType: 'freeform',
    },
  },
};

/**
 * Mistral / Codestral — OpenAI-compatible chat plus a NATIVE FIM endpoint
 * (`/v1/fim/completions`, body `{model, prompt, suffix}`) that powers the
 * editor's ghost-text autocomplete. Free and paid Studio keys use the current
 * public API host (`https://api.mistral.ai/v1`).
 */
export const mistralSpec: ProviderSpec = {
  kind: 'mistral',
  displayName: 'Mistral / Codestral',
  visual: { icon: 'Wind', fg: 'text-amber-500', bg: 'bg-amber-500/15' },
  credKind: 'api-key',
  envVars: ['MISTRAL_API_KEY', 'CODESTRAL_API_KEY'],
  defaultBaseURL: 'https://api.mistral.ai/v1',
  defaultModel: 'mistral-small-latest',
  defaultModels: ['mistral-small-latest', 'mistral-medium-3-5', 'codestral-latest'],
  pricing: {
    'codestral-latest': { inputPer1M: 0.3, outputPer1M: 0.9 },
    'mistral-small-latest': { inputPer1M: 0.1, outputPer1M: 0.3 },
  },
  capabilities: { supportsThinking: true },
  wire: 'openai-compat',
  wireOpts: { vendor: 'mistral' },
  discovery: { from: 'openai-models', requiredCapabilities: ['completion_chat'] },
  test: { from: 'openai-models', fallbackBaseURL: 'https://api.mistral.ai/v1' },
  models: {
    'mistral-small-latest': {
      canReason: true,
      supportedReasoningLevels: ['none', 'high'],
      defaultReasoningLevel: 'none',
    },
    'mistral-medium-3-5': {
      canReason: true,
      supportedReasoningLevels: ['none', 'high'],
      defaultReasoningLevel: 'none',
    },
  },
};

export const OPENAI_COMPAT_SPECS: ProviderSpec[] = [
  openaiSpec,
  deepseekSpec,
  zaiSpec,
  cloudflareSpec,
  openrouterSpec,
  fuguSpec,
  mistralSpec,
];
