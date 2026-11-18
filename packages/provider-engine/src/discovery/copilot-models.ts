import { startCopilotClient, stopCopilotClient, type CopilotModel } from '@mcp/code-agent/providers/copilot-sdk-client.js';
import type { ProviderSpec } from '@mcp/provider-sdk';
import type { ProviderConfig, UpsertModelInput } from '@mcp/store/provider-store.js';

export async function listCopilotModels(providerId: string): Promise<CopilotModel[]> {
  const client = await startCopilotClient(providerId);
  try {
    const status = await client.getAuthStatus();
    if (!status.isAuthenticated) throw new Error('Connect GitHub Copilot in Providers & Models.');
    return await client.listModels();
  } finally {
    await stopCopilotClient(client);
  }
}

export async function discoverCopilotModels(_spec: ProviderSpec, cfg: ProviderConfig): Promise<UpsertModelInput[]> {
  return (await listCopilotModels(cfg.id))
    .filter(model => model.policy?.state !== 'disabled')
    .map(mapCopilotModel);
}

export function mapCopilotModel(model: CopilotModel): UpsertModelInput {
  const { limits, supports } = model.capabilities;
  const efforts = model.supportedReasoningEfforts;
  return {
    model_id: model.id,
    name: model.name,
    display_name: model.name,
    context_window: limits?.max_context_window_tokens ?? limits?.max_prompt_tokens ?? null,
    default_max_tokens: limits?.max_output_tokens ?? null,
    can_reason: supports?.reasoningEffort || !!efforts?.length,
    supports_attachments: supports?.vision ?? false,
    supported_reasoning_levels: efforts?.length ? efforts : null,
    default_reasoning_level: model.defaultReasoningEffort ?? null,
    input_modalities: supports?.vision ? ['text', 'image'] : ['text'],
    visibility: 'list',
    supported_in_api: true,
    source: 'live',
  };
}
