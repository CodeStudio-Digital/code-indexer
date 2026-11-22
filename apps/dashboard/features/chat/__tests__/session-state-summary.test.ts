import { afterEach, expect, it, vi } from 'vitest';
import { subscribeToSessionSummary } from '../useSessionStateSummary.js';

afterEach(() => vi.unstubAllGlobals());

it('shares one read per revision until its last panel leaves', async () => {
  const signals: AbortSignal[] = [];
  const fetchSummary = vi.fn((_url: string, { signal }: RequestInit) => {
    signals.push(signal!);
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason));
    });
  });
  vi.stubGlobal('fetch', fetchSummary);
  const banner = subscribeToSessionSummary('chat', 1);
  const sidebar = subscribeToSessionSummary('chat', 1);
  expect(banner.result).toBe(sidebar.result);
  const next = subscribeToSessionSummary('chat', 2);
  expect(fetchSummary).toHaveBeenCalledTimes(2);
  banner.release();
  expect(signals[0].aborted).toBe(false);
  sidebar.release();
  expect(signals[0].aborted).toBe(true);
  expect(signals[1].aborted).toBe(false);

  // Remount before the cancelled fetch settles. Its cleanup must leave the new one alone.
  const remount = subscribeToSessionSummary('chat', 1);
  await expect(banner.result).rejects.toHaveProperty('name', 'AbortError');
  const additional = subscribeToSessionSummary('chat', 1);
  expect(additional.result).toBe(remount.result);
  remount.release();
  additional.release();
  next.release();
  await Promise.allSettled([remount.result, next.result]);
});
