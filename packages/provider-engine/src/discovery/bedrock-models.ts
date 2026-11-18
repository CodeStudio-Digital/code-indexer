import {
  BedrockClient, ListFoundationModelsCommand, paginateListInferenceProfiles,
  type FoundationModelSummary,
} from '@aws-sdk/client-bedrock';
import { bedrockClientConfig, resolveAwsConfigCredentials, type ProviderSpec, type ResolvedCreds } from '@mcp/provider-sdk';
import type { ProviderConfig, ProviderStore, UpsertModelInput } from '@mcp/store/provider-store.js';
import { getRegistryContextWindow } from '@mcp/code-agent/providers/capabilities.js';

export async function fetchBedrockCatalog(aws: ResolvedCreds['aws']): Promise<UpsertModelInput[]> {
  const client = new BedrockClient({ ...bedrockClientConfig(aws), maxAttempts: 2 });
  const abortSignal = AbortSignal.timeout(25_000);
  try {
    const [foundations, inference] = await Promise.allSettled([
      client.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }), { abortSignal }),
      collectInferenceProfiles(client, abortSignal),
    ]);
    if (foundations.status === 'rejected' && inference.status === 'rejected') throw foundations.reason;
    // A role may allow one of the two listing calls. Other failures should
    // leave the stored catalog intact so a transient outage doesn't wipe it.
    for (const result of [foundations, inference]) {
      if (result.status === 'rejected' && result.reason?.name !== 'AccessDeniedException') throw result.reason;
    }
    const summaries = foundations.status === 'fulfilled' ? foundations.value.modelSummaries ?? [] : [];
    const lookup = new Map(summaries.map(model => [model.modelId, model]));
    const catalog = new Map<string, UpsertModelInput>();
    for (const model of summaries) {
      if (model.modelId && model.inferenceTypesSupported?.includes('ON_DEMAND') && supportsConverse(model)) {
        catalog.set(model.modelId, catalogEntry(model.modelId, model.modelName ?? model.modelId, model));
      }
    }
    for (const profile of inference.status === 'fulfilled' ? inference.value : []) {
      if (profile.status !== 'ACTIVE' || !profile.inferenceProfileId) continue;
      const base = profile.models?.[0]?.modelArn?.split('foundation-model/')[1];
      if (!base || /(?:embed|rerank)/i.test(base)) continue;
      const model = lookup.get(base);
      if (model && !supportsConverse(model)) continue;
      const id = profile.type === 'APPLICATION' ? profile.inferenceProfileArn ?? profile.inferenceProfileId : profile.inferenceProfileId;
      catalog.set(id, catalogEntry(id, profile.inferenceProfileName ?? id, model, base));
    }
    return [...catalog.values()];
  } finally {
    client.destroy();
  }
}

async function collectInferenceProfiles(client: BedrockClient, abortSignal: AbortSignal) {
  const profiles = [];
  for await (const page of paginateListInferenceProfiles({ client, stopOnSameToken: true }, {}, { abortSignal })) {
    profiles.push(...(page.inferenceProfileSummaries ?? []));
  }
  return profiles;
}

function supportsConverse(model: FoundationModelSummary) {
  return model.responseStreamingSupported !== false
    && model.modelLifecycle?.status !== 'LEGACY'
    && (model.outputModalities?.includes('TEXT') ?? true);
}

function catalogEntry(id: string, name: string, model?: FoundationModelSummary, baseId = id): UpsertModelInput {
  const metadata = bedrockModelMetadata(baseId);
  return {
    model_id: id,
    name,
    display_name: name,
    context_window: metadata.contextWindow,
    default_max_tokens: metadata.maxTokens,
    can_reason: metadata.canReason,
    supports_attachments: metadata.supportsAttachments || (model?.inputModalities?.includes('IMAGE') ?? false),
    supported_reasoning_levels: metadata.supportedReasoningLevels,
    default_reasoning_level: metadata.defaultReasoningLevel,
    input_modalities: (model?.inputModalities ?? ['TEXT']).map(value => value.toLowerCase()),
    visibility: 'list',
    supported_in_api: true,
    source: 'live',
  };
}

export async function discoverBedrockModels(_spec: ProviderSpec, cfg: ProviderConfig, store: ProviderStore) {
  const creds = await resolveAwsConfigCredentials(cfg, { get: async () => store.getOAuth(cfg.id) });
  return fetchBedrockCatalog(creds.aws);
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
