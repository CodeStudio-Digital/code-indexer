import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';

type BedrockExtra = {
  region?: string;
  aws_region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
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

async function loadSdk(): Promise<BedrockSdk> {
  const modName = '@aws-sdk/client-bedrock';
  try {
    return (await import(/* @vite-ignore */ modName)) as BedrockSdk;
  } catch (e) {
    throw new Error(
      `Bedrock control-plane operations require @aws-sdk/client-bedrock. ` +
        `Install with: pnpm add @aws-sdk/client-bedrock (${(e as Error).message})`,
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
  cfg: ProviderConfig,
): { region: string; tok: BedrockExtra } {
  const oauth = store.getOAuth(cfg.id);
  const tok = (oauth?.extra || {}) as BedrockExtra;
  const cfgExtra = (cfg.extra || {}) as BedrockExtra;
  const region = tok.region ?? tok.aws_region ?? cfgExtra.aws_region ?? process.env.AWS_REGION ?? 'us-east-1';
  return { region, tok };
}

export async function checkModelAccess(
  store: ProviderStore,
  cfg: ProviderConfig,
  modelId: string,
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

export async function requestModelAccess(
  store: ProviderStore,
  cfg: ProviderConfig,
  modelId: string,
  useCaseData?: UseCaseFormData,
): Promise<{ alreadyAuthorized: boolean; modelId: string }> {
  const { region, tok } = resolveRegionAndCreds(store, cfg);
  const sdk = await loadSdk();
  const client = makeClient(sdk, region, tok);

  const status = await checkModelAccess(store, cfg, modelId);
  if (status.authorizationStatus === 'AUTHORIZED') {
    return { alreadyAuthorized: true, modelId };
  }

  const offersCmd = new sdk.ListFoundationModelAgreementOffersCommand({
    modelId,
    offerType: 'ALL',
  });
  const offersResp = await client.send(offersCmd);
  const offers: AgreementOffer[] = offersResp.offers ?? offersResp.modelAgreementOffers ?? [];
  if (offers.length === 0) {
    throw new Error(
      `No agreement offers found for model "${modelId}". ` +
        `The model may not support on-demand access in region ${region}.`,
    );
  }
  const offerToken = offers[0].offerToken ?? offers[0].offerId;
  if (!offerToken) {
    throw new Error(`Agreement offer for "${modelId}" is missing an offerToken.`);
  }

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
      const msg = (e as Error).message ?? '';
      if (!/already submitted|already exists/i.test(msg)) throw e;
    }
  }

  const agreementCmd = new sdk.CreateFoundationModelAgreementCommand({
    modelId,
    offerToken,
  });
  await client.send(agreementCmd);

  return { alreadyAuthorized: false, modelId };
}
