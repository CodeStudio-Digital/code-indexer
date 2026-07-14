import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saveProvider: vi.fn(),
  addProviderModel: vi.fn(),
  fetchProviders: vi.fn(async () => []),
  fetchProviderModels: vi.fn(async () => []),
  activateBinding: vi.fn(async () => ({ id: 9, binding: null, disabledIds: [2] })),
  apiCall: vi.fn(),
}));

vi.mock('../../../admin/api.js', () => ({
  saveProvider: mocks.saveProvider,
  addProviderModel: mocks.addProviderModel,
  fetchProviders: mocks.fetchProviders,
  fetchProviderModels: mocks.fetchProviderModels,
}));
vi.mock('../../../admin/pipeline-bindings-api.js', () => ({ activateBinding: mocks.activateBinding }));
vi.mock('../../../../lib/api-client.js', () => ({ apiCall: mocks.apiCall }));

import { AC_PRESETS, applyAcPreset } from '../autocompleteSetupPresets.js';

const passingProbe = {
  ok: true, verifiedForAutomatic: true,
  samples: [
    { language: 'typescript', latencyMs: 300, ttftMs: 200, status: 'ok' },
    { language: 'php', latencyMs: 350, ttftMs: 220, status: 'ok' },
    { language: 'python', latencyMs: 320, ttftMs: 210, status: 'ok' },
  ],
  latency: { p50: 320, p90: 350 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchProviders.mockResolvedValue([]);
  mocks.fetchProviderModels.mockResolvedValue([]);
});

describe('applyAcPreset activation', () => {
  it('activates Codestral only after its completion probe succeeds', async () => {
    mocks.apiCall.mockResolvedValue(passingProbe);
    const preset = AC_PRESETS.find((item) => item.id === 'codestral-free')!;
    const result = await applyAcPreset(preset, { apiKey: 'secret' }, { relatedCodeConsent: true });
    expect(result.ok).toBe(true);
    expect(mocks.activateBinding).toHaveBeenCalledWith(expect.objectContaining({
      pipeline_name: 'editor', binding_role: 'autocomplete',
      provider_id: 'mistral-codestral', model_id: 'codestral-latest',
      config: expect.objectContaining({ context_engine: 'v3', ctx_related_code_consent_v: 1 }),
    }));
  });

  it('does not change active bindings on probe failure unless Bind anyway is explicit', async () => {
    mocks.apiCall.mockResolvedValue({
      ok: false, verifiedForAutomatic: false, samples: [],
      latency: { p50: null, p90: null }, message: 'Probe failed.',
    });
    const preset = AC_PRESETS.find((item) => item.id === 'codestral-free')!;
    const failed = await applyAcPreset(preset, { apiKey: 'secret' });
    expect(failed.testWarning).toContain('Probe failed.');
    expect(mocks.activateBinding).not.toHaveBeenCalled();

    const forced = await applyAcPreset(preset, { apiKey: 'secret' }, { bindAnyway: true });
    expect(forced).toMatchObject({ ok: true, forced: true });
    expect(mocks.activateBinding).toHaveBeenCalledTimes(1);
  });

  it('also probes an existing chat model before replacing the active binding', async () => {
    mocks.apiCall.mockResolvedValue({
      ok: false, verifiedForAutomatic: false, samples: [],
      latency: { p50: null, p90: null }, message: 'Chat endpoint failed.',
    });
    const preset = AC_PRESETS.find((item) => item.id === 'chat-model')!;
    const result = await applyAcPreset(preset, { existingProviderId: 'existing', existingModelId: 'slow-chat' });
    expect(result.testWarning).toContain('Chat endpoint failed.');
    expect(mocks.apiCall).toHaveBeenCalledWith('editor.probe', { providerId: 'existing', modelId: 'slow-chat' });
    expect(mocks.activateBinding).not.toHaveBeenCalled();
  });
});
