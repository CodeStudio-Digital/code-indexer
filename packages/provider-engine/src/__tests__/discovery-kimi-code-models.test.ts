import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  ProviderConfig,
  ProviderStore,
  UpsertModelInput,
} from '@mcp/store/provider-store.js';

// Both the admin helper and the engine builder import the SAME service
// symbols (resolveKimiCodeCreds + the kimi-code oauth module), so mocking each
// module once makes both call sites share the identical fakes. Equivalence then
// reduces to: do both wire the same args into the same fns and apply the same
// fallback/seed/throw semantics?
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

// Imported AFTER vi.mock (hoisted) so both pick up the fakes.
import { discoverKimiCode } from '@apps/http-api/admin/model-discovery/kimi-code.js';
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

describe('kimi-code-models discovery equivalence: engine(spec, cfg, store) == admin discoverKimiCode(store, cfg)', () => {
  it('normal models — maps live list (no seed)', async () => {
    const LIVE = [{ id: 'kimi-k2.6' }];
    const MAPPED: UpsertModelInput[] = [
      { model_id: 'kimi-k2.6', name: 'Kimi K2.6', context_window: 256_000, source: 'live' },
    ];
    fetchKimiCodeModels.mockResolvedValue(LIVE);
    mapKimiCodeModels.mockReturnValue(MAPPED);

    const a = await discoverKimiCode(STORE, CFG);
    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(a);
    expect(b).toEqual(MAPPED);
  });

  it('empty mapped list → seed', async () => {
    fetchKimiCodeModels.mockResolvedValue([]);
    mapKimiCodeModels.mockReturnValue([]);

    const a = await discoverKimiCode(STORE, CFG);
    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(a);
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
    const a = await discoverKimiCode(STORE, CFG);
    wire();
    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(a);
    expect(b).toEqual(MAPPED);
  });

  it('non-401 fetch error → outer catch → seed', async () => {
    fetchKimiCodeModels.mockRejectedValue(new Error('HTTP 500 boom'));

    const a = await discoverKimiCode(STORE, CFG);
    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(a);
    expect(b).toEqual(SEED);
  });

  it('resolveKimiCodeCreds rejects → outer catch → seed', async () => {
    resolveKimiCodeCreds.mockRejectedValue(new Error('no Kimi Code access token stored'));

    const a = await discoverKimiCode(STORE, CFG);
    const b = await discoverKimiCodeModels(kimiCodeSpec, CFG, STORE);

    expect(b).toEqual(a);
    expect(b).toEqual(SEED);
  });
});
