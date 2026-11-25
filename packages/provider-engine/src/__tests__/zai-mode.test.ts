import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withReasoningCapabilities, type ResolvedCreds } from '@mcp/provider-sdk';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import { resolveBaseURL } from '../wire-helpers/base-url.js';
import { discoverOpenAIModels } from '../discovery/openai-models.js';
import { zaiSpec } from '../specs/openai-compat.js';
import { buildOpenAICompat } from '../wires/openai-compat.js';
import { buildOpenAICompat as buildPluginWire } from '@mcp/provider-runtime/wires/openai-compat.js';
import { zaiSpec as zaiPluginSpec } from '../../../../extensions/provider-zai/src/spec.js';

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

    it('enriches bare GLM IDs with the Coding Plan effort options', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }, { id: 'glm-5.4' }],
      })));
      const cfg = { id: '1', kind: 'zai', api_key: 'k', base_url: null, extra: { zai_mode: 'coding' } } as unknown as ProviderConfig;

      const models = await discoverOpenAIModels(zaiSpec, cfg);
      expect(models.map(model => model.model_id)).toEqual(['glm-5.3', 'glm-5.3-flash', 'glm-5.4']);
      for (const model of models) {
        expect(model).toMatchObject({ can_reason: true, supported_reasoning_levels: ['low', 'high', 'max'],
          default_reasoning_level: 'max' });
      }
    });

    it('no plan mode + legacy zai_has_coding_mode flag still duplicates (back-compat)', async () => {
      const cfg = { id: '1', kind: 'zai', api_key: 'k', base_url: null, extra: { zai_has_coding_mode: true } } as unknown as ProviderConfig;
      const out = await discoverOpenAIModels(zaiSpec, cfg);
      expect(lastUrl).toBe('https://api.z.ai/api/paas/v4/models');
      expect(out.map((m) => m.mode)).toEqual(['normal', 'coding']);
    });
  });
});

describe.each([
  ['built-in', buildOpenAICompat, zaiSpec],
  ['plugin runtime', buildPluginWire, zaiPluginSpec],
] as const)('%s Z.AI Coding Plan request', (_name, build, spec) => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { modelId: 'glm-5.3', savedDefault: null, selected: 'high', expected: 'high' },
    { modelId: 'glm-5.3', savedDefault: 'high', selected: null, expected: 'high' },
    { modelId: 'glm-5.3', savedDefault: 'high', selected: 'low', expected: 'low' },
    { modelId: 'glm-5.3', savedDefault: null, selected: null, expected: 'max' },
    { modelId: 'glm-5.4', savedDefault: 'high', selected: 'low', expected: 'low' },
    { modelId: 'glm-5.4', savedDefault: null, selected: 'high', expected: 'high' },
    { modelId: 'glm-5.4', savedDefault: 'high', selected: 'max', expected: 'max' },
    { modelId: 'glm-5.4', savedDefault: null, selected: null, expected: 'max' },
  ])('sends $expected for $modelId with session $selected and model default $savedDefault', async ({
    modelId, savedDefault, selected, expected,
  }: { modelId: string; savedDefault: string | null; selected: string | null; expected: string }) => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const model = `${modelId}::coding`;
    const wire = build(spec).createCoder!({ apiKey: 'fixture', baseURL: GENERAL }, model);
    const provider = withReasoningCapabilities(wire, [{
      model_id: modelId, mode: 'coding', can_reason: true,
      supported_reasoning_levels: ['low', 'high', 'max'], default_reasoning_level: savedDefault,
    }], model, { useModelDefault: true });
    for await (const _ of provider.chat({ system: '', messages: [], tools: [], thinking: false, reasoningEffort: selected })) {
      // Consume the reply so the SDK receives the body.
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${CODING}chat/completions`,
      body: { model: modelId, thinking: { type: 'enabled' }, reasoning_effort: expected },
    });
  });
});
