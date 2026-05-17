import type { LLMProvider } from '@mcp/indexer/indexer/providers/base.js';
import { SYSTEM_PROMPT, buildUserPrompt, parseAnalysisResponse } from '@mcp/indexer/indexer/providers/base.js';
import type { AnalysisResult } from '@mcp/shared/types.js';

/**
 * Amazon Bedrock indexer provider — single-shot Converse call.
 *
 * Unlike the coder's BedrockChatProvider (which uses ConverseStream with
 * tool calling), the indexer just needs one round-trip with a system
 * prompt + user prompt and a text response. We use the non-streaming
 * Converse API for simplicity. The AWS SDK is loaded via dynamic import
 * so users who don't use Bedrock don't pay the ~10MB dependency cost.
 *
 * Credential resolution matches BedrockChatProvider: explicit creds from
 * opts win, otherwise the AWS default credential chain (env vars,
 * ~/.aws/credentials, EC2/ECS instance role) is used. Region falls back
 * to AWS_REGION / AWS_DEFAULT_REGION / us-east-1.
 */
interface ConverseClient {
  send: (cmd: unknown) => Promise<ConverseOutput>;
}

interface ConverseOutput {
  output?: {
    message?: {
      role: string;
      content?: Array<{ text?: string }>;
    };
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  stopReason?: string;
}

interface BedrockSdkModule {
  BedrockRuntimeClient: new (cfg: unknown) => ConverseClient;
  ConverseCommand: new (input: unknown) => unknown;
}

export class BedrockIndexerProvider implements LLMProvider {
  readonly name = 'bedrock';
  readonly model: string;
  private region: string;
  private credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  private clientPromise: Promise<{ client: ConverseClient; sdk: BedrockSdkModule }> | null = null;

  constructor(opts: {
    model?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  }) {
    this.model = opts.model ?? 'anthropic.claude-3-5-haiku-20241022-v1:0';
    this.region =
      opts.region ??
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      'us-east-1';
    if (opts.accessKeyId && opts.secretAccessKey) {
      this.credentials = {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
      };
    }
  }

  private async getClient(): Promise<{ client: ConverseClient; sdk: BedrockSdkModule }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        let sdk: BedrockSdkModule;
        try {
          // Variable import spec avoids TS2307 when the optional peer
          // @aws-sdk/client-bedrock-runtime is not installed at build time.
          const modName = '@aws-sdk/client-bedrock-runtime';
          sdk = (await import(modName)) as unknown as BedrockSdkModule;
        } catch (e) {
          throw new Error(
            'Bedrock indexer requires @aws-sdk/client-bedrock-runtime. ' +
              'Install it with: npm install @aws-sdk/client-bedrock-runtime. ' +
              `Original error: ${(e as Error).message}`,
          );
        }
        const client = new sdk.BedrockRuntimeClient({
          region: this.region,
          ...(this.credentials ? { credentials: this.credentials } : {}),
        });
        return { client, sdk };
      })();
    }
    return this.clientPromise;
  }

  async analyzeFile(filePath: string, content: string): Promise<AnalysisResult> {
    const { client, sdk } = await this.getClient();
    const cmd = new sdk.ConverseCommand({
      modelId: this.model,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [
        {
          role: 'user',
          content: [{ text: buildUserPrompt(filePath, content) }],
        },
      ],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0,
      },
    });

    const response = await client.send(cmd);
    const text =
      response.output?.message?.content
        ?.map((b) => b.text ?? '')
        .join('') ?? '';

    return {
      analysis: parseAnalysisResponse(text, filePath),
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
  }
}
