import { describe, expect, it, vi } from 'vitest';
import { providerAdapter } from '../plugin.js';

const credentials = {
  get: vi.fn(async () => null),
  set: vi.fn(async () => {}),
  mirrorApiKey: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
};

describe('provider-claude-code runtime boundary', () => {
  it('delegates exotic credential resolution to the host capability', async () => {
    const resolved = { authToken: 'token', baseURL: 'https://api.anthropic.com' };
    const resolveHostCredentials = vi.fn(async () => resolved);

    await expect(
      providerAdapter.resolveCredentials?.({
        config: { id: 'claude', kind: 'claude-code' },
        credentials,
        resolveHostCredentials,
        fetch,
        log: () => {},
      }),
    ).resolves.toEqual(resolved);
    expect(resolveHostCredentials).toHaveBeenCalledOnce();
  });

  it('fails explicitly when an incompatible host omits the capability', async () => {
    await expect(
      providerAdapter.resolveCredentials?.({
        config: { id: 'claude', kind: 'claude-code' },
        credentials,
        fetch,
        log: () => {},
      }),
    ).rejects.toThrow(/host credential resolver is unavailable/i);
  });
});
