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
} from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';

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

type FoundationModelAvailabilityResponse = {
  modelId?: string;
  agreementAvailability?: { status?: string };
  authorizationStatus?: string;
  entitlementAvailability?: string;
};

type AgreementOffer = {
  offerToken?: string;
  offerId?: string;
};

type BedrockControlClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (cmd: unknown) => Promise<any>;
};

type BedrockSdk = {
  BedrockClient: new (cfg: unknown) => BedrockControlClient;
  ListFoundationModelsCommand: new (input: unknown) => unknown;
  GetFoundationModelAvailabilityCommand: new (input: unknown) => unknown;
  ListFoundationModelAgreementOffersCommand: new (input: unknown) => unknown;
  PutUseCaseForModelAccessCommand: new (input: unknown) => unknown;
  CreateFoundationModelAgreementCommand: new (input: unknown) => unknown;
};

export type ModelAccessStatus = {
  modelId: string;
  agreementAvailability: { status: string } | undefined;
  authorizationStatus: string | undefined;
  entitlementAvailability: string | undefined;
};

export type UseCaseFormData = {
  companyName: string;
  companyWebsite: string;
  intendedUsers: string;
  industryOption: string;
  otherIndustryOption?: string;
  useCases: string;
};

// ─── Shared client factory ──────────────────────────────────────

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

// ─── Model discovery ────────────────────────────────────────────

export async function discoverBedrock(store: ProviderStore, cfg: ProviderConfig): Promise<UpsertModelInput[]> {
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

// ─── Model access check ─────────────────────────────────────────

export async function checkModelAccess(
  store: ProviderStore,
  cfg: ProviderConfig,
  modelId: string
): Promise<ModelAccessStatus> {
  const { region, tok } = resolveRegionAndCreds(store, cfg);
  const sdk = await loadSdk();
  const client = makeClient(sdk, region, tok);
  const cmd = new sdk.GetFoundationModelAvailabilityCommand({ modelId });
  const resp: FoundationModelAvailabilityResponse = await client.send(cmd);
  return {
    modelId: resp.modelId ?? modelId,
    agreementAvailability: resp.agreementAvailability?.status
      ? { status: resp.agreementAvailability.status }
      : undefined,
    authorizationStatus: resp.authorizationStatus,
    entitlementAvailability: resp.entitlementAvailability,
  };
}

// ─── Model access subscription ──────────────────────────────────

export async function requestModelAccess(
  store: ProviderStore,
  cfg: ProviderConfig,
  modelId: string,
  useCaseData?: UseCaseFormData
): Promise<{ alreadyAuthorized: boolean; modelId: string }> {
  const { region, tok } = resolveRegionAndCreds(store, cfg);
  const sdk = await loadSdk();
  const client = makeClient(sdk, region, tok);

  // Step 1: check if already authorized
  const status = await checkModelAccess(store, cfg, modelId);
  if (status.authorizationStatus === 'AUTHORIZED') {
    return { alreadyAuthorized: true, modelId };
  }

  // Step 2: get the offer token required to create the agreement
  const offersCmd = new sdk.ListFoundationModelAgreementOffersCommand({
    modelId,
    offerType: 'ALL',
  });
  const offersResp = await client.send(offersCmd);
  const offers: AgreementOffer[] = offersResp.offers ?? offersResp.modelAgreementOffers ?? [];
  if (offers.length === 0) {
    throw new Error(`No agreement offers found for model "${modelId}". The model may not support on-demand access in region ${region}.`);
  }
  const offerToken = offers[0].offerToken ?? offers[0].offerId;
  if (!offerToken) {
    throw new Error(`Agreement offer for "${modelId}" is missing an offerToken.`);
  }

  // Step 3: submit use-case form for Anthropic models (one-time per account)
  const isAnthropic = modelId.toLowerCase().startsWith('anthropic.');
  if (isAnthropic) {
    const form = useCaseData ?? {
      companyName: 'Self',
      companyWebsite: 'https://example.com',
      intendedUsers: '0',
      industryOption: 'Other',
      otherIndustryOption: '',
      useCases: 'Internal AI assistant and coding tools',
    };
    try {
      const useCaseCmd = new sdk.PutUseCaseForModelAccessCommand({
        formData: JSON.stringify(form),
      });
      await client.send(useCaseCmd);
    } catch (e) {
      // AWS returns an error if the form was already submitted — treat as non-fatal
      const msg = (e as Error).message ?? '';
      if (!/already submitted|already exists/i.test(msg)) throw e;
    }
  }

  // Step 4: create the agreement (subscribes the account to the model)
  const agreementCmd = new sdk.CreateFoundationModelAgreementCommand({
    modelId,
    offerToken,
  });
  await client.send(agreementCmd);

  return { alreadyAuthorized: false, modelId };
}
