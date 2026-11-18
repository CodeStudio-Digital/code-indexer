import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withReasoningCapabilities, type ResolvedCreds } from '@mcp/provider-sdk';
import type { ProviderConfig } from '@mcp/store/provider-store.js';
import { resolveBaseURL } from '../wire-helpers/base-url.js';
import { discoverOpenAIModels } from '../discovery/openai-models.js';
import { zaiSpec } from '../specs/openai-compat.js';
import { buildOpenAICompat } from '../wires/openai-compat.js';
import { buildOpenAICompat as buildPluginWire } from '@mcp/provider-runtime/wires/openai-compat.js';
import { zaiSpec as zaiPluginSpec } from '../../../../extensions/provider-zai/src/spec.js';

const { create, clients } = vi.hoisted(() => ({ create: vi.fn(), clients: [] as Record<string, unknown>[] }));
vi.mock('openai', () => ({ default: class {
  chat = { completions: { create } };
  constructor(options: Record<string, unknown>) { clients.push(options); }
} }));

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

    it('enriches bare GLM-5.3 IDs with the Coding Plan effort options', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }],
      })));
      const cfg = { id: '1', kind: 'zai', api_key: 'k', base_url: null, extra: { zai_mode: 'coding' } } as unknown as ProviderConfig;

      const models = await discoverOpenAIModels(zaiSpec, cfg);
      expect(models.map(model => model.model_id)).toEqual(['glm-5.3', 'glm-5.3-flash']);
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
  it.each([
    { savedDefault: null, selected: 'high', expected: 'high' },
    { savedDefault: 'high', selected: null, expected: 'high' },
    { savedDefault: 'high', selected: 'low', expected: 'low' },
    { savedDefault: null, selected: null, expected: 'max' },
  ])('sends $expected for session $selected and model default $savedDefault', async ({ savedDefault, selected, expected }) => {
    clients.length = 0;
    create.mockReset();
    create.mockResolvedValueOnce((async function* () {
      yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
    })());

    const model = 'glm-5.3::coding';
    const wire = build(spec).createCoder!({ apiKey: 'fixture', baseURL: GENERAL }, model);
    const provider = withReasoningCapabilities(wire, [{
      model_id: 'glm-5.3', mode: 'coding', can_reason: true,
      supported_reasoning_levels: ['low', 'high', 'max'], default_reasoning_level: savedDefault,
    }], model, { useModelDefault: true });
    for await (const _ of provider.chat({ system: '', messages: [], tools: [], thinking: false, reasoningEffort: selected })) {
      // Consume the reply so the SDK receives the body.
    }

    expect(clients[0]?.baseURL).toBe(CODING);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      model: 'glm-5.3', thinking: { type: 'enabled' }, reasoning_effort: expected,
    });
  });
});
