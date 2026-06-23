/**
 * Live model discovery for the `sdk:bedrock` format.
 *
 * Lifted verbatim from the hand-written admin helper
 * `apps/http-api/admin/model-discovery/bedrock.ts` (`discoverBedrock`). Only the
 * model-discovery path is lifted — the sibling `checkModelAccess` /
 * `requestModelAccess` control-plane helpers stay in the admin file.
 *
 * Behaviour is identical: the same dynamic `import('@aws-sdk/client-bedrock')`,
 * the same `ListFoundationModelsCommand({ byOutputModality: 'TEXT' })`, the same
 * region/credential resolution, the same ON_DEMAND / TEXT filters, the same map
 * to `UpsertModelInput[]`, and the same fallback/throw semantics. The equivalence
 * test asserts deep equality of the returned `UpsertModelInput[]`.
 *
 * Bedrock takes no parameters from `spec.discovery` (region + creds come from the
 * provider row / OAuth extra / env), so `spec` is unused beyond the signature.
 */
import type {
  ProviderConfig,
  ProviderStore,
  UpsertModelInput,
} from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
import type { ProviderSpec } from '@mcp/provider-sdk';

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

type BedrockControlClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (cmd: unknown) => Promise<any>;
};

type BedrockSdk = {
  BedrockClient: new (cfg: unknown) => BedrockControlClient;
  ListFoundationModelsCommand: new (input: unknown) => unknown;
};

async function loadSdk(): Promise<BedrockSdk> {
  const modName = '@aws-sdk/client-bedrock';
  try {
    return (await import(/* @vite-ignore */ modName)) as BedrockSdk;
  } catch (e) {
    throw new Error(
      `Bedrock control-plane operations require @aws-sdk/client-bedrock. ` +
        `Install with: pnpm add @aws-sdk/client-bedrock (${(e as Error).message})`
    );
  }
}

function makeClient(sdk: BedrockSdk, region: string, tok: BedrockExtra): BedrockControlClient {
  return new sdk.BedrockClient({
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
}

function resolveRegionAndCreds(
  store: ProviderStore,
  cfg: ProviderConfig
): { region: string; tok: BedrockExtra } {
  const oauth = store.getOAuth(cfg.id);
  const tok = (oauth?.extra || {}) as BedrockExtra;
  const cfgExtra = (cfg.extra || {}) as BedrockExtra;
  const region = tok.region ?? tok.aws_region ?? cfgExtra.aws_region ?? process.env.AWS_REGION ?? 'us-east-1';
  return { region, tok };
}

export async function discoverBedrockModels(
  _spec: ProviderSpec,
  cfg: ProviderConfig,
  store: ProviderStore
): Promise<UpsertModelInput[]> {
  const { region, tok } = resolveRegionAndCreds(store, cfg);
  try {
    const sdk = await loadSdk();
    const client = makeClient(sdk, region, tok);
    const cmd = new sdk.ListFoundationModelsCommand({ byOutputModality: 'TEXT' });
    const resp = await client.send(cmd);
    const models: BedrockModelSummary[] = resp.modelSummaries ?? [];
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
