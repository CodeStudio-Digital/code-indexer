import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

const runtime = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), getAuthStatus: vi.fn(), listModels: vi.fn(),
}));
vi.mock('@mcp/code-agent/providers/copilot-sdk-client.js', () => ({
  startCopilotClient: runtime.start, stopCopilotClient: runtime.stop,
}));
import { discoverCopilotModels } from '../discovery/copilot-models.js';
import { copilotSpec } from '../specs/copilot.js';

afterEach(() => vi.resetAllMocks());

describe('Copilot SDK model discovery', () => {
  const config = { id: 'copilot-enterprise' } as ProviderConfig;

  it('uses the account catalog, including model-specific limits and effort', async () => {
    runtime.getAuthStatus.mockResolvedValue({ isAuthenticated: true });
    runtime.listModels.mockResolvedValue([
      { id: 'model-1', name: 'Visible model',
        capabilities: { limits: { max_context_window_tokens: 128000 }, supports: { vision: true } },
        supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' },
      { id: 'forbidden', name: 'Disabled model', capabilities: {}, policy: { state: 'disabled' } },
    ]);
    const client = { getAuthStatus: runtime.getAuthStatus, listModels: runtime.listModels };
    runtime.start.mockResolvedValue(client);

    const models = await discoverCopilotModels(copilotSpec, config);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      model_id: 'model-1', context_window: 128000, supports_attachments: true,
      supported_reasoning_levels: ['low', 'high'], default_reasoning_level: 'low',
    });
    expect(runtime.start).toHaveBeenCalledWith(config.id);
    expect(runtime.stop).toHaveBeenCalledWith(client);
  });

  it('reports missing authentication and closes the runtime', async () => {
    runtime.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    const client = { getAuthStatus: runtime.getAuthStatus, listModels: runtime.listModels };
    runtime.start.mockResolvedValue(client);
    await expect(discoverCopilotModels(copilotSpec, config)).rejects.toThrow('Connect GitHub Copilot');
    expect(runtime.listModels).not.toHaveBeenCalled();
    expect(runtime.stop).toHaveBeenCalledWith(client);
  });
});
