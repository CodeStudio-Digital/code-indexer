import type {
  ProviderDiscoverModelsContext,
  ProviderDiscoveredModel,
  ProviderDiscoveryResult,
} from '@mcp/provider-sdk';

type GeminiModel = {
  name: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
};

export async function discoverGoogleOAuthModels(
  ctx: ProviderDiscoverModelsContext,
): Promise<ProviderDiscoveryResult> {
  const response = await ctx.fetch('https://generativelanguage.googleapis.com/v1beta/models', {
    headers: { Authorization: `Bearer ${ctx.creds.apiKey ?? ''}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const data = (await response.json()) as { models?: GeminiModel[] };
  return {
    models: (data.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes('generateContent') ?? true)
      .map(toUpsertInput),
    etag: null,
    notModified: false,
  };
}

function toUpsertInput(model: GeminiModel): ProviderDiscoveredModel {
  return {
    model_id: model.name.replace(/^models\//, ''),
    name: model.displayName ?? model.name,
    context_window: model.inputTokenLimit ?? null,
    default_max_tokens: model.outputTokenLimit ?? null,
    source: 'live',
  };
}
