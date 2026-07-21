import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig, ProviderStore, UpsertModelInput } from '@mcp/store/provider-store.js';

const SEED: UpsertModelInput[] = [
  { model_id: 'kimi-k2.6', name: 'Kimi K2.6', context_window: 256_000, source: 'seed' },
];
const fetchKimiCodeModels = vi.fn();
const mapKimiCodeModels = vi.fn();
const kimiCodeSeedUpsertModels = vi.fn(() => SEED);

vi.mock('@mcp/services/services/kimi-code.js', () => ({
  fetchKimiCodeModels: (...args: unknown[]) => fetchKimiCodeModels(...args),
  mapKimiCodeModels: (...args: unknown[]) => mapKimiCodeModels(...args),
  kimiCodeSeedUpsertModels: () => kimiCodeSeedUpsertModels(),
}));

import { discoverKimiCodeModels } from '../discovery/kimi-code-models.js';
import { kimiCodeSpec } from '../specs/kimi.js';

const CFG = {
  id: 'kimi-code',
  api_key: 'user-api-token',
  base_url: 'https://api.kimi.com/coding/v1',
} as ProviderConfig;
const STORE = {} as ProviderStore;

beforeEach(() => {
  vi.clearAllMocks();
  kimiCodeSeedUpsertModels.mockReturnValue(SEED);
});

describe('kimi-code API-key model discovery', () => {
  it('uses the persisted API token and maps the live catalog', async () => {
    const live = [{ id: 'k3' }];
    const mapped: UpsertModelInput[] = [
      { model_id: 'k3', name: 'Kimi K3', context_window: 1_048_576, source: 'live' },
    ];
    fetchKimiCodeModels.mockResolvedValue(live);
    mapKimiCodeModels.mockReturnValue(mapped);

    await expect(discoverKimiCodeModels(kimiCodeSpec, CFG, STORE)).resolves.toEqual(mapped);
    expect(fetchKimiCodeModels).toHaveBeenCalledWith({
      baseURL: CFG.base_url,
      apiKey: 'user-api-token',
    });
  });

  it('falls back to seeds when the live catalog is empty', async () => {
    fetchKimiCodeModels.mockResolvedValue([]);
    mapKimiCodeModels.mockReturnValue([]);
    await expect(discoverKimiCodeModels(kimiCodeSpec, CFG, STORE)).resolves.toEqual(SEED);
  });

  it('does not attempt OAuth refresh after an authentication failure', async () => {
    fetchKimiCodeModels.mockRejectedValue(new Error('HTTP 401'));
    await expect(discoverKimiCodeModels(kimiCodeSpec, CFG, STORE)).resolves.toEqual(SEED);
    expect(fetchKimiCodeModels).toHaveBeenCalledTimes(1);
  });

  it('does not call the API until an API token is configured', async () => {
    await expect(discoverKimiCodeModels(
      kimiCodeSpec,
      { ...CFG, api_key: null },
      STORE,
    )).resolves.toEqual(SEED);
    expect(fetchKimiCodeModels).not.toHaveBeenCalled();
  });
});
