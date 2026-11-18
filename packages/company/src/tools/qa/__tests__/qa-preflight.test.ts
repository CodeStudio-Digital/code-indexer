import { describe, expect, it } from 'vitest';
import type { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import { preflightBrowser } from '../qa-preflight.js';

function envStore(value: string, source: string) {
  return { listAsync: async () => [{ key: 'PLAYWRIGHT_WS_ENDPOINT', value, source }] } as unknown as CompanySessionEnvStore;
}

describe('Playwright configuration', () => {
  it('accepts an explicitly configured WebSocket without probing it from the IDE', async () => {
    const endpoint = 'wss://qa.example.test/browser';
    const result = await preflightBrowser({ sessionId: 'qa', envStore: envStore(endpoint, 'user') });
    expect(result).toEqual({ ok: true, wsEndpoint: endpoint });
  });

  it.each([['ws://host.docker.internal:9222/', 'auto'], ['https://qa.example.test/', 'user']])(
    'asks the operator to configure the suite for %s (%s)', async (endpoint, source) => {
      const result = await preflightBrowser({ sessionId: 'qa', envStore: envStore(endpoint, source) });
      expect(result).toMatchObject({ ok: false, message: expect.stringContaining('PLAYWRIGHT_WS_ENDPOINT') });
    },
  );
});
