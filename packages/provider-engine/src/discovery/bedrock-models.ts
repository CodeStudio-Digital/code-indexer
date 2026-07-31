/**
 * Live model discovery for the `sdk:bedrock` format.
 *
 * Uses dynamic `import('@aws-sdk/client-bedrock')`,
 * `ListFoundationModelsCommand({ byOutputModality: 'TEXT' })`, provider-row
 * region/credential resolution, ON_DEMAND/TEXT filters, and maps the result to
 * `UpsertModelInput[]`.
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
      .map((m): UpsertModelInput => {
        const id = m.modelId ?? 'unknown';
        const metadata = bedrockModelMetadata(id);
        const name = `${m.providerName ?? ''} ${m.modelName ?? id}`.trim();
        return {
          model_id: id,
          name,
          display_name: name,
          context_window: metadata.contextWindow ?? getRegistryContextWindow(id),
          default_max_tokens: metadata.maxTokens,
          can_reason: metadata.canReason,
          supports_attachments:
            metadata.supportsAttachments
            || (m.inputModalities ?? []).some((modality) => modality !== 'TEXT'),
          supported_reasoning_levels: metadata.supportedReasoningLevels,
          default_reasoning_level: metadata.defaultReasoningLevel,
          input_modalities: (m.inputModalities ?? ['TEXT']).map((value) => value.toLowerCase()),
          visibility: 'list',
          supported_in_api: true,
          source: 'live' as const,
        };
      });
  } catch (e) {
    throw new Error(
      `Bedrock model discovery failed. Install @aws-sdk/client-bedrock ` +
        `and verify credentials + region (${region}): ${(e as Error).message}`
    );
  }
}

export function bedrockModelMetadata(model: string): {
  contextWindow: number | null;
  maxTokens: number | null;
  canReason: boolean;
  supportsAttachments: boolean;
  supportedReasoningLevels: string[] | null;
  defaultReasoningLevel: string | null;
} {
  const id = model
    .toLowerCase()
    .replace(/^(?:global|us|eu|apac|au|ca|jp|kr|in|br)\./, '');
  if (
    /^anthropic\.claude-(?:fable|mythos|opus)-5/.test(id)
    || /^anthropic\.claude-sonnet-5/.test(id)
  ) {
    return {
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'high',
    };
  }
  if (/^anthropic\.claude-(?:opus-4-[678]|sonnet-4-6)/.test(id)) {
    return {
      contextWindow: id.includes('opus-4-8') || id.includes('opus-4-7')
        ? 1_000_000
        : 200_000,
      maxTokens: 64_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningLevel: 'high',
    };
  }
  if (/^amazon\.nova-(?:2-|(?:pro|lite)-1-5)/.test(id)) {
    return {
      contextWindow: getRegistryContextWindow(id),
      maxTokens: 50_000,
      canReason: true,
      supportsAttachments: true,
      supportedReasoningLevels: ['low', 'medium', 'high'],
      defaultReasoningLevel: 'medium',
    };
  }
  return {
    contextWindow: getRegistryContextWindow(id),
    maxTokens: null,
    canReason: false,
    supportsAttachments: false,
    supportedReasoningLevels: null,
    defaultReasoningLevel: null,
  };
}
