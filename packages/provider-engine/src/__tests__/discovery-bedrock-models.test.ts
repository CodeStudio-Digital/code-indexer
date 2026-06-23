import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';

// Both the admin `discoverBedrock` and the engine `discoverBedrockModels`
// dynamic-import '@aws-sdk/client-bedrock', so one module mock intercepts both.
// `BedrockClient.send` ignores the command and returns the representative
// `modelSummaries` list; `ListFoundationModelsCommand` is a no-op marker.
const MODEL_SUMMARIES = [
  // Kept: ON_DEMAND + TEXT output.
  {
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    modelName: 'Claude 3.5 Sonnet v2',
    providerName: 'Anthropic',
    outputModalities: ['TEXT'],
    inferenceTypesSupported: ['ON_DEMAND'],
  },
  // Dropped: PROVISIONED-only (no ON_DEMAND).
  {
    modelId: 'meta.llama3-70b-instruct-v1:0',
    modelName: 'Llama 3 70B Instruct',
    providerName: 'Meta',
    outputModalities: ['TEXT'],
    inferenceTypesSupported: ['PROVISIONED'],
  },
  // Dropped: non-TEXT output modality.
  {
    modelId: 'amazon.titan-image-generator-v1',
    modelName: 'Titan Image Generator',
    providerName: 'Amazon',
    outputModalities: ['IMAGE'],
    inferenceTypesSupported: ['ON_DEMAND'],
  },
  // Kept via the `?? true` fallbacks: missing inference types AND modalities,
  // plus missing modelName/providerName so the name-trim branch is exercised.
  {
    modelId: 'unknown.model-no-meta',
  },
];

vi.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: vi.fn().mockImplementation(function () {
    return { send: async () => ({ modelSummaries: MODEL_SUMMARIES }) };
  }),
  ListFoundationModelsCommand: vi.fn().mockImplementation(function (input: unknown) {
    return { input };
  }),
}));

import { BedrockClient } from '@aws-sdk/client-bedrock';
import { discoverBedrock } from '@apps/http-api/admin/model-discovery/bedrock.js';
import { discoverBedrockModels } from '../discovery/bedrock-models.js';
import { bedrockSpec } from '../specs/bedrock.js';

// The code reads only `id` and `extra` off the config, and `getOAuth(id)` off
// the store. Minimal fakes are enough; cast to the full types for the calls.
const CFG = { id: 7, extra: { aws_region: 'us-west-2' } } as unknown as ProviderConfig;

const STORE = {
  getOAuth: () => ({
    extra: { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'sess' },
  }),
} as unknown as ProviderStore;

afterEach(() => {
  vi.clearAllMocks();
});

describe('bedrock-models discovery equivalence: engine(spec, cfg, store) == admin discoverBedrock(store, cfg)', () => {
  it('returns identical UpsertModelInput[]', async () => {
    const a = await discoverBedrock(STORE, CFG);
    const b = await discoverBedrockModels(bedrockSpec, CFG, STORE);
    expect(b).toEqual(a);
    // Pin the lifted shape: both filters applied, name trimmed, and the
    // capability-registry context window resolved per modelId.
    expect(b).toEqual([
      {
        model_id: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        name: 'Anthropic Claude 3.5 Sonnet v2',
        context_window: getCtx('anthropic.claude-3-5-sonnet-20241022-v2:0'),
        source: 'live',
      },
      {
        model_id: 'unknown.model-no-meta',
        name: 'unknown.model-no-meta',
        context_window: getCtx('unknown.model-no-meta'),
        source: 'live',
      },
    ]);
  });

  it('both THROW when the SDK send rejects — never silently wipe the catalog', async () => {
    vi.mocked(BedrockClient).mockImplementation(
      () => ({ send: async () => { throw new Error('AWS down'); } }) as unknown as BedrockClient,
    );
    await expect(discoverBedrock(STORE, CFG)).rejects.toThrow();
    await expect(discoverBedrockModels(bedrockSpec, CFG, STORE)).rejects.toThrow();
  });
});

// Local copy of the same registry lookup both builders use, so the pinned
// `context_window` stays in lockstep with the capability registry rather than
// hardcoding a value that could drift.
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';
function getCtx(id: string): number | null {
  return getRegistryContextWindow(id);
}
