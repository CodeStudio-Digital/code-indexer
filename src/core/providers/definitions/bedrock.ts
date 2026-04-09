import { defineProvider } from '../types.js';
import { BedrockIndexerProvider } from '../../indexer/providers/bedrock.js';
import { BedrockChatProvider } from '../../coder/providers/bedrock.js';

/**
 * AWS Bedrock — Converse / ConverseStream API.
 *
 * credKind='aws': `resolveBedrockCreds` reads access key / secret /
 * session token / region from oauth_tokens.extra (written by
 * POST /oauth/bedrock/credentials in http-api/admin.ts). Falls back to
 * the standard AWS default credential chain (EC2/ECS role, env vars,
 * ~/.aws/credentials) if the store is empty — useful for running on
 * AWS infra.
 *
 * Multiple instances of the same shape supported: users can create
 * `bedrock-prod` and `bedrock-dev` rows with different AWS accounts.
 */
export const bedrock = defineProvider({
  kind: 'bedrock',
  displayName: 'AWS Bedrock',
  credKind: 'aws',
  envVars: [],
  defaultModels: [
    'anthropic.claude-3-5-haiku-20241022-v1:0',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'anthropic.claude-3-opus-20240229-v1:0',
    'meta.llama3-70b-instruct-v1:0',
  ],
  pricing: {
    'anthropic.claude-3-5-haiku-20241022-v1:0':  { inputPer1M: 0.80, outputPer1M: 4.00 },
    'anthropic.claude-3-5-sonnet-20241022-v2:0': { inputPer1M: 3.00, outputPer1M: 15.00 },
    'anthropic.claude-3-opus-20240229-v1:0':     { inputPer1M: 15.00, outputPer1M: 75.00 },
    'meta.llama3-70b-instruct-v1:0':             { inputPer1M: 2.65, outputPer1M: 3.50 },
  },
  createIndexer: (creds, model) =>
    new BedrockIndexerProvider({
      model,
      region: creds.aws?.region,
      accessKeyId: creds.aws?.accessKeyId,
      secretAccessKey: creds.aws?.secretAccessKey,
      sessionToken: creds.aws?.sessionToken,
    }),
  createCoder: (creds, model) =>
    new BedrockChatProvider({
      model,
      region: creds.aws?.region,
      accessKeyId: creds.aws?.accessKeyId,
      secretAccessKey: creds.aws?.secretAccessKey,
      sessionToken: creds.aws?.sessionToken,
    }),
});
