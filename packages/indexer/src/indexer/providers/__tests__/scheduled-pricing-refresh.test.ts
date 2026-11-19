import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderStore } from '@mcp/store/provider-store.js';
import type { PriceSource } from '@mcp/services/services/pricing/index.js';
import { refreshAllModelPrices, startModelPricingRefreshScheduler } from '../scheduled-pricing-refresh.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it('skips both sources when remote pricing is off, including a timer already scheduled', async () => {
  vi.useFakeTimers();
  vi.stubEnv('MODEL_PRICING_REFRESH_INTERVAL_MS', '60000');
  const store = {} as ProviderStore;
  const sources: PriceSource[] = [
    { tag: 'litellm', fetch: vi.fn() },
    { tag: 'openrouter', fetch: vi.fn() },
  ];
  const stop = startModelPricingRefreshScheduler(store, sources);
  try {
    vi.stubEnv('MODEL_PRICING_REMOTE_ENABLED', '0');
    expect(await refreshAllModelPrices(store, sources)).toMatchObject({
      sources: [], remoteSyncDisabled: true, hydrated: false,
    });
    await vi.advanceTimersByTimeAsync(65_000);
    for (const source of sources) expect(source.fetch).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});
