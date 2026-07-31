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
  const id = model.name.replace(/^models\//, '');
  const metadata = geminiReasoningMetadata(id);
  return {
    model_id: id,
    name: model.displayName ?? model.name,
    display_name: model.displayName ?? model.name,
    context_window: model.inputTokenLimit ?? metadata.contextWindow,
    default_max_tokens: model.outputTokenLimit ?? metadata.maxTokens,
    can_reason: metadata.canReason,
    supports_attachments: metadata.supportsAttachments,
    supported_reasoning_levels: metadata.supportedReasoningLevels,
    default_reasoning_level: metadata.defaultReasoningLevel,
    input_modalities: metadata.inputModalities,
    visibility: 'list',
    supported_in_api: true,
    source: 'live',
  };
}

function geminiReasoningMetadata(model: string) {
  const id = model.toLowerCase();
  const isGemini3 = /^gemini-3(?:[.-]|$)/.test(id);
  const isPro = /(?:^|-)pro(?:-|$)/.test(id);
  const isThinking25 = /^gemini-2\.5(?:-|$)/.test(id);
  const canReason = isGemini3 || isThinking25;
  const levels = isGemini3
    ? (isPro ? ['low', 'medium', 'high'] : ['minimal', 'low', 'medium', 'high'])
    : isThinking25
      ? ['minimal', 'low', 'medium', 'high']
      : null;
  return {
    contextWindow: /^gemini-3\.6-flash(?:-|$)/.test(id) ? 1_048_576 : null,
    maxTokens: /^gemini-3\.6-flash(?:-|$)/.test(id) ? 65_536 : null,
    canReason,
    supportsAttachments: true,
    supportedReasoningLevels: levels,
    defaultReasoningLevel: canReason ? (isPro ? 'high' : 'medium') : null,
    inputModalities: ['text', 'image', 'audio', 'video', 'pdf'],
  };
}
