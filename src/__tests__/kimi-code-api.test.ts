import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providersRouter } from '@apps/http-api/admin/providers.routes.js';
import { CodeIndexDB } from '@mcp/store/db.js';
import { ProviderStore } from '@mcp/store/provider-store.js';

describe('Kimi Code API-token connection', () => {
  let dir: string;
  let db: CodeIndexDB;
  let store: ProviderStore;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-code-api-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    store = new ProviderStore(db.raw());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('validates and stores the user API token without an OAuth row', async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer user-api-token');
      return new Response(JSON.stringify({
        data: [{ id: 'k3', display_name: 'Kimi K3', context_length: 1_048_576 }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });

    const response = await providersRouter(store).request('/providers/kimi-code/connect-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: ' user-api-token ' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider_id: 'kimi-code', model_count: 1 });
    expect(store.getProvider('kimi-code')).toMatchObject({
      kind: 'kimi-code',
      auth_mode: 'api_key',
      api_key: 'user-api-token',
      base_url: 'https://api.kimi.com/coding/v1',
    });
    expect(store.getOAuth('kimi-code')).toBeNull();
    expect(store.listModels('kimi-code')[0]).toMatchObject({
      model_id: 'k3',
      supported_reasoning_levels: ['low', 'high', 'max'],
      default_reasoning_level: 'max',
    });
  });

  it('does not persist a rejected API token', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 401 }));
    const response = await providersRouter(store).request('/providers/kimi-code/connect-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_token: 'bad-token' }),
    });

    expect(response.status).toBe(400);
    expect(store.getProvider('kimi-code')).toBeNull();
  });

  it('rejects OAuth auth_mode through generic provider creation', async () => {
    const response = await providersRouter(store).request('/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'kimi-code',
        name: 'Kimi Code',
        kind: 'kimi-code',
        auth_mode: 'oauth',
        api_key: 'token',
      }),
    });

    expect(response.status).toBe(400);
    expect(store.getProvider('kimi-code')).toBeNull();
  });
});
