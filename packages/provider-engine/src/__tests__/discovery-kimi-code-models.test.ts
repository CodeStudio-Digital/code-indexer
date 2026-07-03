import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ProviderConfig,
  ProviderStore,
  UpsertModelInput,
} from '@mcp/store/provider-store.js';

const SEED: UpsertModelInput[] = [
  { model_id: 'kimi-k2.6', name: 'Kimi K2.6', context_window: 256_000, source: 'seed' },
];

const resolveKimiCodeCreds = vi.fn();
const fetchKimiCodeModels = vi.fn();
const mapKimiCodeModels = vi.fn();
const kimiCodeSeedUpsertModels = vi.fn((..._a: unknown[]) => SEED);
const refreshIfExpired = vi.fn();

vi.mock('@mcp/services/providers/shared/oauth.js', () => ({
  resolveKimiCodeCreds: (...a: unknown[]) => resolveKimiCodeCreds(...a),
}));

vi.mock('@mcp/services/services/oauth/kimi-code.js', () => ({
  fetchKimiCodeModels: (...a: unknown[]) => fetchKimiCodeModels(...a),
  mapKimiCodeModels: (...a: unknown[]) => mapKimiCodeModels(...a),
  kimiCodeSeedUpsertModels: (...a: unknown[]) => kimiCodeSeedUpsertModels(...a),
  refreshIfExpired: (...a: unknown[]) => refreshIfExpired(...a),
}));

import { discoverKimiCodeModels } from '../discovery/kimi-code-models.js';
import { kimiCodeSpec } from '../specs/kimi.js';

const CFG = {
  id: 7,
  api_key: 'ak',
  base_url: 'https://api.kimi.com/coding/v1',
} as unknown as ProviderConfig;

// Minimal fake store — the lifted code only passes it through to
// resolveKimiCodeCreds / refreshKimiCodeToken, both of which are mocked, so no
// real method is invoked. Provide a bare object cast to satisfy the type.
const STORE = {} as unknown as ProviderStore;

const CREDS = {
  apiKey: 'live-token',
  baseURL: 'https://api.kimi.com/coding/v1',
  extraHeaders: { 'x-h': '1' },
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveKimiCodeCreds.mockResolvedValue(CREDS);
  kimiCodeSeedUpsertModels.mockReturnValue(SEED);
});

describe('kimi-code-models discovery', () => {
  it('normal models — maps live list (no seed)', async () => {
    const LIVE = [{ id: 'kimi-k2.6' }];
    const MAPPED: UpsertModelInput[] = [
      { model_id: 'kimi-k2.6', name: 'Kimi K2.6', context_window: 256_000, source: 'live' },
    ];
    fetchKimiCodeModels.mockResolvedValue(LIVE);
    mapKimiCodeModels.mockReturnValue(MAPPED);

    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(MAPPED);
  });

  it('empty mapped list → seed', async () => {
    fetchKimiCodeModels.mockResolvedValue([]);
    mapKimiCodeModels.mockReturnValue([]);

    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(SEED);
  });

  it('401 → force-refresh retry, then maps', async () => {
    const LIVE = [{ id: 'kimi-k2.5' }];
    const MAPPED: UpsertModelInput[] = [
      { model_id: 'kimi-k2.5', name: 'Kimi K2.5', context_window: 256_000, source: 'live' },
    ];
    // First call throws HTTP 401, second (post-refresh) succeeds. Reset per
    // builder so each sees the same two-step sequence.
    const wire = () => {
      fetchKimiCodeModels.mockReset();
      fetchKimiCodeModels
        .mockRejectedValueOnce(new Error('HTTP 401 unauthorized'))
        .mockResolvedValueOnce(LIVE);
      refreshIfExpired.mockResolvedValue('refreshed-token');
      mapKimiCodeModels.mockReturnValue(MAPPED);
    };

    wire();
    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(MAPPED);
  });

  it('non-401 fetch error → outer catch → seed', async () => {
    fetchKimiCodeModels.mockRejectedValue(new Error('HTTP 500 boom'));

    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(SEED);
  });

  it('resolveKimiCodeCreds rejects → outer catch → seed', async () => {
    resolveKimiCodeCreds.mockRejectedValue(new Error('no Kimi Code access token stored'));

    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(SEED);
  });
});
