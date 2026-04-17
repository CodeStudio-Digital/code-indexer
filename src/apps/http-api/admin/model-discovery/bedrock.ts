/**
 * Amazon Bedrock model discovery via @aws-sdk/client-bedrock (control plane).
 *
 * Loaded via dynamic-import-from-variable so TS doesn't require the types at
 * build time and the dep stays optional — users who don't use Bedrock don't
 * need to install the SDK.
 */
import type {
  ProviderStore,
  ProviderConfig,
  UpsertModelInput,
} from '../../../../store/provider-store.js';
import { getRegistryContextWindow } from '../../../../core/coder/providers/capabilities.js';

type BedrockExtra = {
  region?: string;
  aws_region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
};

type BedrockModelSummary = {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
};

type BedrockSdk = {
  BedrockClient: new (cfg: unknown) => {
    send: (cmd: unknown) => Promise<{ modelSummaries?: BedrockModelSummary[] }>;
  };
  ListFoundationModelsCommand: new (input: unknown) => unknown;
};

export async function discoverBedrock(store: ProviderStore, cfg: ProviderConfig): Promise<UpsertModelInput[]> {
  const oauth = store.getOAuth(cfg.id);
  const tok = (oauth?.extra || {}) as BedrockExtra;
  const cfgExtra = (cfg.extra || {}) as BedrockExtra;
  const region = tok.region ?? tok.aws_region ?? cfgExtra.aws_region ?? process.env.AWS_REGION ?? 'us-east-1';
  try {
    const modName = '@aws-sdk/client-bedrock';
    const sdk = (await import(/* @vite-ignore */ modName)) as BedrockSdk;
    const client = new sdk.BedrockClient({
      region,
      credentials:
        tok.accessKeyId && tok.secretAccessKey
          ? {
              accessKeyId: tok.accessKeyId,
              secretAccessKey: tok.secretAccessKey,
              sessionToken: tok.sessionToken,
            }
          : undefined,
    });
    const cmd = new sdk.ListFoundationModelsCommand({ byOutputModality: 'TEXT' });
    const resp = await client.send(cmd);
    const models = resp.modelSummaries ?? [];
    return models
      // Only list text-generation models that are actually invokable; some
      // rows are embedding-only or marked for provisioned throughput only.
      .filter((m) => m.inferenceTypesSupported?.includes('ON_DEMAND') ?? true)
      .filter((m) => m.outputModalities?.includes('TEXT') ?? true)
      .map(
        (m): UpsertModelInput => ({
          model_id: m.modelId ?? 'unknown',
          name: `${m.providerName ?? ''} ${m.modelName ?? m.modelId ?? ''}`.trim(),
          context_window: getRegistryContextWindow(m.modelId ?? ''),
          source: 'live' as const,
        })
      );
  } catch (e) {
    throw new Error(
      `Bedrock model discovery failed. Install @aws-sdk/client-bedrock ` +
        `and verify credentials + region (${region}): ${(e as Error).message}`
    );
  }
}
