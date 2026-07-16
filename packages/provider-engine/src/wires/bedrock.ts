import type { ProviderSpec, ProviderDefinition } from '@mcp/provider-sdk';
import { BedrockChatProvider } from '@mcp/code-agent/providers/bedrock.js';

type WireParts = Pick<
  ProviderDefinition,
  'createCoder' | 'fetchModels' | 'testConnection'
>;

/**
 * AWS Bedrock coder wire (Converse / ConverseStream API).
 *
 * GOTCHA: the model is passed through RAW (no `?? defaultModels[0]` default).
 * The adapter applies its own default when `model` is undefined, so defaulting
 * here would change behaviour. Credentials come from
 * `creds.aws` (credKind='aws'); when absent the adapters fall back to the AWS
 * default credential chain.
 */
export function buildBedrock(_spec: ProviderSpec): WireParts {
  return {
    createCoder: (creds, model) =>
      new BedrockChatProvider({
        model,
        region: creds.aws?.region,
        accessKeyId: creds.aws?.accessKeyId,
        secretAccessKey: creds.aws?.secretAccessKey,
        sessionToken: creds.aws?.sessionToken,
      }),
  };
}
