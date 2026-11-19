import type { ProviderSpec } from '../spec.js';

/**
 * Declarative spec for the AWS Bedrock built-in. credKind='aws' — creds come
 * from `creds.aws` (access key / secret / session token / region). No
 * `defaultBaseURL` is declared.
 */
export const bedrockSpec: ProviderSpec = {
  kind: 'bedrock',
  displayName: 'AWS Bedrock',
  visual: { icon: 'Cloud', fg: 'text-amber-500', bg: 'bg-amber-500/15' },
  credKind: 'aws',
  envVars: [],
  defaultModel: 'anthropic.claude-sonnet-5',
  defaultModels: [
    'anthropic.claude-sonnet-5',
    'anthropic.claude-fable-5',
    'anthropic.claude-opus-4-8',
    'amazon.nova-2-lite-v1:0',
  ],
  pricing: {
    'anthropic.claude-sonnet-5': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'anthropic.claude-fable-5': { inputPer1M: 10.0, outputPer1M: 50.0 },
    'anthropic.claude-opus-4-8': { inputPer1M: 5.0, outputPer1M: 25.0 },
    'anthropic.claude-3-5-haiku-20241022-v1:0': { inputPer1M: 0.8, outputPer1M: 4.0 },
    'anthropic.claude-3-5-sonnet-20241022-v2:0': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'anthropic.claude-3-opus-20240229-v1:0': { inputPer1M: 15.0, outputPer1M: 75.0 },
    'meta.llama3-70b-instruct-v1:0': { inputPer1M: 2.65, outputPer1M: 3.5 },
  },
  // Converse accepts document blocks, but support is model-specific. The HTTP
  // route currently enables native PDF for the Claude-on-Bedrock family and
  // extracts text for unknown/unsupported models.
  capabilities: {
    supportsThinking: true,
    supportsVision: true,
    fileInput: 'model-dependent',
  },
  semantic: {
    embedding: {
      protocol: 'bedrock',
      defaultModels: ['amazon.titan-embed-text-v2:0', 'amazon.titan-embed-text-v1'],
      modelPatterns: ['embed'],
    },
    rerank: {
      protocol: 'bedrock',
      defaultModels: ['amazon.rerank-v1:0', 'cohere.rerank-v3-5:0'],
      modelPatterns: ['rerank'],
    },
  },
  wire: 'bedrock',
  discovery: { from: 'sdk:bedrock' },
  models: {
    'anthropic.claude-sonnet-5': {
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'high',
    },
    'anthropic.claude-fable-5': {
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'high',
    },
    'anthropic.claude-opus-4-8': {
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'high',
    },
    'amazon.nova-2-lite-v1:0': {
      maxTokens: 50_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningLevel: 'medium',
    },
  },
};

export const BEDROCK_SPECS: ProviderSpec[] = [bedrockSpec];
