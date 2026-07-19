import { describe, expect, it, vi } from 'vitest';
import { waitForDevServer } from '../wait-for-dev-server.js';

function response(status: number): Response {
  return new Response('', { status });
}

describe('waitForDevServer', () => {
  it('retries connection failures until the dashboard responds', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:7317'))
      .mockResolvedValueOnce(response(200));
    const sleep = vi.fn(async () => undefined);

    await waitForDevServer('http://localhost:7317/', {
      fetchImpl,
      sleep,
      retryDelayMs: 1,
      timeoutMs: 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('accepts a non-5xx response as proof that the configured server is ready', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(404));

    await expect(waitForDevServer('http://localhost:7317/app', { fetchImpl }))
      .resolves.toBeUndefined();
  });

  it('fails with the endpoint and last error after the deadline', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket unavailable'));

    await expect(waitForDevServer('http://localhost:7317/', {
      fetchImpl,
      timeoutMs: 0,
    })).rejects.toThrow(
      'Timed out after 0ms waiting for the dashboard at http://localhost:7317/. Last error: socket unavailable',
    );
  });
});
