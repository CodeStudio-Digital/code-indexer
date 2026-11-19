import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';

const mocks = vi.hoisted(() => ({ client: vi.fn(), send: vi.fn(), destroy: vi.fn(), profiles: vi.fn() }));
vi.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: vi.fn(function (config) { mocks.client(config); return { send: mocks.send, destroy: mocks.destroy }; }),
  ListFoundationModelsCommand: vi.fn(function (input) { return { input }; }),
  paginateListInferenceProfiles: mocks.profiles,
}));
import { discoverBedrockModels } from '../discovery/bedrock-models.js';
import { bedrockSpec } from '../specs/bedrock.js';

const config = { id: 'bedrock', kind: 'bedrock', extra: { aws_region: 'us-west-2' } } as unknown as ProviderConfig;
const store = { getOAuth: () => ({ extra: { bedrockApiKey: 'fixture-key' } }) } as unknown as ProviderStore;
const sonnet = 'anthropic.claude-sonnet-5';
const nova = 'amazon.nova-2-lite-v1:0';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.profiles.mockImplementation(async function* () {
    yield { inferenceProfileSummaries: [
      { inferenceProfileId: 'us.' + sonnet, status: 'ACTIVE', models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/' + sonnet }] },
    ] };
    yield { inferenceProfileSummaries: [
      { type: 'APPLICATION', inferenceProfileId: 'my-profile', inferenceProfileArn: 'arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/my-profile',
        status: 'ACTIVE', models: [{ modelArn: 'arn:aws:bedrock:us-west-2::foundation-model/' + nova }] },
    ] };
  });
  mocks.send.mockResolvedValue({ modelSummaries: [
    { modelId: sonnet, outputModalities: ['TEXT'], inferenceTypesSupported: ['PROVISIONED'], responseStreamingSupported: true },
    { modelId: nova, outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'], responseStreamingSupported: true },
    { modelId: 'amazon.image', outputModalities: ['IMAGE'], inferenceTypesSupported: ['ON_DEMAND'] },
    { modelId: 'nonstreaming.model', outputModalities: ['TEXT'], inferenceTypesSupported: ['ON_DEMAND'], responseStreamingSupported: false },
  ] });
});

describe('Bedrock regional discovery', () => {
  it('lists streamable direct models and profile IDs/ARNs across pages', async () => {
    const models = await discoverBedrockModels(bedrockSpec, config, store);
    expect(models.map(model => model.model_id)).toEqual([
      nova, 'us.' + sonnet, 'arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/my-profile',
    ]);
    expect(models[1]).toMatchObject({ context_window: 1_000_000, supports_attachments: true });
    expect(mocks.client).toHaveBeenCalledWith(expect.objectContaining({
      region: 'us-west-2', token: { token: 'fixture-key' },
    }));
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it('surfaces transport failure instead of replacing the cached catalog', async () => {
    mocks.send.mockRejectedValue(new Error('AWS unavailable'));
    await expect(discoverBedrockModels(bedrockSpec, config, store)).rejects.toThrow('AWS unavailable');
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
