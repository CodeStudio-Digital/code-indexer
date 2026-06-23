import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderConfig, ProviderStore } from '@mcp/store/provider-store.js';

// Both the admin helper and the engine builder import refreshIfExpired from the
// SAME specifier, so one mock backs both call sites — equivalence reduces to:
// do both wire the same token into the same fetch + apply the same parsing?
vi.mock('@mcp/services/services/oauth/google.js', () => ({
  refreshIfExpired: vi.fn(async () => 'fresh-token'),
}));

import { discoverGoogleOAuth } from '@apps/http-api/admin/model-discovery/google-oauth.js';
import { discoverGoogleOAuthModels } from '../discovery/google-oauth-models.js';
import { googleOAuthSpec } from '../specs/google-oauth.js';

const CFG = { id: 'g1', kind: 'google-oauth', api_key: 'stale', base_url: null } as unknown as ProviderConfig;
const STORE = {} as ProviderStore;
const origFetch = globalThis.fetch;

function mockModels() {
  globalThis.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1000000, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/no-methods', displayName: 'Kept by default' },
        ],
      }),
      { status: 200 },
    ),
  ) as unknown as typeof fetch;
}

describe('google-oauth discovery equivalence: engine == admin discoverGoogleOAuth', () => {
  beforeEach(() => mockModels());
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it('returns identical UpsertModelInput[] (generateContent filter + name strip + token limits)', async () => {
    const a = await discoverGoogleOAuth(STORE, CFG);
    const b = await discoverGoogleOAuthModels(googleOAuthSpec, CFG, STORE);
    expect(b).toEqual(a);
    // embedding-001 filtered out; no-methods kept (?? true); models/ prefix stripped
    expect(b.map((m) => m.model_id)).toEqual(['gemini-2.5-pro', 'no-methods']);
  });

  it('both THROW on a non-ok models response (no silent wipe)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
    await expect(discoverGoogleOAuth(STORE, CFG)).rejects.toThrow('HTTP 403');
    await expect(discoverGoogleOAuthModels(googleOAuthSpec, CFG, STORE)).rejects.toThrow('HTTP 403');
  });
});
