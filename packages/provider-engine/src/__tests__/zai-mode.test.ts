import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvedCreds } from '@mcp/provider-sdk';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import { resolveBaseURL } from '../wire-helpers/base-url.js';
import { discoverOpenAIModels } from '../discovery/openai-models.js';
import { zaiSpec } from '../specs/openai-compat.js';

const CODING = 'https://api.z.ai/api/coding/paas/v4/';
const GENERAL = 'https://api.z.ai/api/paas/v4/';

/** The declarative z.ai "plan mode" select: a provider-level default mode in
 *  extra.zai_mode drives the endpoint; the per-model `::mode` suffix overrides it. */
describe('z.ai plan mode (declarative)', () => {
  const creds = (mode?: string): ResolvedCreds => ({ apiKey: 'k', extra: mode ? { zai_mode: mode } : {} });

  it('provider-level default mode picks the endpoint when the model has no ::suffix', () => {
    expect(resolveBaseURL(zaiSpec, creds('coding'), undefined)).toBe(CODING);
    expect(resolveBaseURL(zaiSpec, creds('normal'), undefined)).toBe(GENERAL);
  });

  it('the per-model ::mode suffix still overrides the provider default', () => {
    // default = coding, but the request asked for general → general wins.
    expect(resolveBaseURL(zaiSpec, creds('coding'), 'general')).toBe(GENERAL);
  });

  it('no plan mode + no base_url falls back to the general endpoint', () => {
    expect(resolveBaseURL(zaiSpec, creds(undefined), undefined)).toBe(GENERAL);
  });

  describe('discovery uses the selected plan endpoint', () => {
    const origFetch = globalThis.fetch;
    let lastUrl = '';
    beforeEach(() => {
      lastUrl = '';
      globalThis.fetch = vi.fn(async (url: unknown) => {
        lastUrl = String(url);
        return new Response(JSON.stringify({ data: [{ id: 'glm-4.6' }] }), { status: 200 });
      }) as unknown as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = origFetch;
    });

    it('coding mode lists models from the coding /models endpoint (plain ids, no duplication)', async () => {
      const cfg = { id: '1', kind: 'zai', api_key: 'k', base_url: null, extra: { zai_mode: 'coding' } } as unknown as ProviderConfig;
      const out = await discoverOpenAIModels(zaiSpec, cfg);
      expect(lastUrl).toBe('https://api.z.ai/api/coding/paas/v4/models');
      expect(out.map((m) => m.model_id)).toEqual(['glm-4.6']); // no (normal)/(coding) duplication
    });

    it('no plan mode + legacy zai_has_coding_mode flag still duplicates (back-compat)', async () => {
      const cfg = { id: '1', kind: 'zai', api_key: 'k', base_url: null, extra: { zai_has_coding_mode: true } } as unknown as ProviderConfig;
      const out = await discoverOpenAIModels(zaiSpec, cfg);
      expect(lastUrl).toBe('https://api.z.ai/api/paas/v4/models');
      expect(out.map((m) => m.mode)).toEqual(['normal', 'coding']);
    });
  });
});
