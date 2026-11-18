import { afterEach, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForFreeModelSlot, noteFreeModelRateLimit } from '../free-model-rate-limit.js';
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('shares the same account budget between embedding and reranking, without throttling paid or other providers', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  await waitForFreeModelSlot('https://openrouter.ai/api/v1/embeddings', 'embed:free', 'fixture-shared');
  await waitForFreeModelSlot('https://openrouter.ai/api/v1/rerank', 'rerank:free', 'fixture-shared');
  expect(delay).toHaveBeenCalledExactlyOnceWith(3500, undefined, { signal: undefined });
  await waitForFreeModelSlot('https://openrouter.ai/api/v1/embeddings', 'embed:paid', 'fixture-shared');
  await waitForFreeModelSlot('https://other.example/embeddings', 'embed:free', 'fixture-shared');
  await waitForFreeModelSlot('https://openrouter.ai/api/v1/embeddings', 'embed:free', 'fixture-other');
  expect(delay).toHaveBeenCalledOnce();
});

it('preserves reset guidance, fails fast during long cooldowns, and automatically resumes after the quota window', async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000);
  const suffix = noteFreeModelRateLimit('https://openrouter.ai/api/v1/embeddings', 'embed:free', 'quota-key',
    new Response('', { status: 429 }), JSON.stringify({ error: { metadata: { headers: { 'X-RateLimit-Reset': '320000' } } } }));
  expect(suffix).toBe(' Retry-After: 120');
  await expect(waitForFreeModelSlot('https://openrouter.ai/api/v1/rerank', 'rerank:free', 'quota-key')).rejects.toThrow('Retry-After: 120');
  expect(delay).not.toHaveBeenCalled();
  vi.setSystemTime(320_001);
  await expect(waitForFreeModelSlot('https://openrouter.ai/api/v1/rerank', 'rerank:free', 'quota-key')).resolves.toBeUndefined();
});

it('honors cancellation before reserving a slot and passes the signal to short waits', async () => {
  vi.useFakeTimers(); vi.setSystemTime(400_000);
  const controller = new AbortController(); controller.abort();
  await expect(waitForFreeModelSlot('https://openrouter.ai/api/v1/embeddings', 'embed:free', 'cancel-key', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  const signal = new AbortController().signal;
  await waitForFreeModelSlot('https://openrouter.ai/api/v1/embeddings', 'embed:free', 'cancel-key', signal);
  await waitForFreeModelSlot('https://openrouter.ai/api/v1/embeddings', 'embed:free', 'cancel-key', signal);
  expect(delay).toHaveBeenCalledExactlyOnceWith(3500, undefined, { signal });
});
