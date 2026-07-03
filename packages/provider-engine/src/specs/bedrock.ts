import type { ProviderSpec } from '@mcp/provider-sdk';

/**
 * Declarative spec for the AWS Bedrock built-in. credKind='aws' — creds come
 * from `creds.aws` (access key / secret / session token / region). No
 * `defaultModel`, `capabilities`, or `defaultBaseURL` are declared.
 */
export const bedrockSpec: ProviderSpec = {
  kind: 'bedrock',
  displayName: 'AWS Bedrock',
  visual: { icon: 'Cloud', fg: 'text-amber-500', bg: 'bg-amber-500/15' },
  credKind: 'aws',
  envVars: [],
  defaultModels: [
    'anthropic.claude-3-5-haiku-20241022-v1:0',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'anthropic.claude-3-opus-20240229-v1:0',
    'meta.llama3-70b-instruct-v1:0',
  ],
  pricing: {
    'anthropic.claude-3-5-haiku-20241022-v1:0': { inputPer1M: 0.8, outputPer1M: 4.0 },
    'anthropic.claude-3-5-sonnet-20241022-v2:0': { inputPer1M: 3.0, outputPer1M: 15.0 },
    'anthropic.claude-3-opus-20240229-v1:0': { inputPer1M: 15.0, outputPer1M: 75.0 },
    'meta.llama3-70b-instruct-v1:0': { inputPer1M: 2.65, outputPer1M: 3.5 },
  },
  wire: 'bedrock',
  discovery: { from: 'sdk:bedrock' },
  test: { from: 'unsupported', message: 'bedrock test not implemented' },
};

export const BEDROCK_SPECS: ProviderSpec[] = [bedrockSpec];
