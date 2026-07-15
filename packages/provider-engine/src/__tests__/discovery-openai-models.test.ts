import { describe, it, expect, afterEach } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

import { discoverOpenAIModels } from '../discovery/openai-models.js';
import { openaiSpec, zaiSpec, fuguSpec, mistralSpec } from '../specs/openai-compat.js';
import { moonshotSpec } from '../specs/moonshot.js';

/**
 * OpenAI-compatible discovery covers base-url derived catalogs, prefix filters,
 * ZAI mode duplication and metadata gap-fill from spec.models.
 */

const realFetch = globalThis.fetch;

/** Install a fetch stub that records the URL it was called with and returns `body`. */
function stubFetch(body: unknown): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { calls };
}

function baseCfg(over: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'p1',
    name: 'p',
    kind: 'openai',
    base_url: null,
    api_key: null,
    auth_mode: 'api-key',
    enabled: true,
    use_for_agent: true,
    use_for_coder: true,
    use_for_general: true,
    is_default: false,
    extra: {},
    fallback_provider_id: null,
    ...over,
  } as ProviderConfig;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('discoverOpenAIModels', () => {
  // A representative OpenAI /models response: a couple of known ids (have a
  // registry context window) plus an unknown one (context_window -> null).
  const OPENAI_RESPONSE = {
    data: [
      { id: 'gpt-4o-mini' },
      { id: 'gpt-4o' },
      { id: 'text-embedding-3-small' },
    ],
  };

  it('(a) openai: plain list maps ids from /models', async () => {
    const cfg = baseCfg({ base_url: 'https://api.openai.com/v1', api_key: 'k' });

    stubFetch(OPENAI_RESPONSE);
    const b = await discoverOpenAIModels(openaiSpec, cfg);

    expect(b.map((m) => m.model_id)).toEqual(['gpt-4o-mini', 'gpt-4o', 'text-embedding-3-small']);
    expect(b.every((m) => m.source === 'live')).toBe(true);
  });

  it('(a) openai: supportsModes + zai_has_coding_mode duplicates normal/coding rows', async () => {
    const cfg = baseCfg({
      base_url: 'https://api.openai.com/v1',
      api_key: 'k',
      extra: { zai_has_coding_mode: true },
    });

    const specWithModes = {
      ...openaiSpec,
      discovery: { ...openaiSpec.discovery!, supportsModes: ['normal', 'coding'] },
    };
    stubFetch(OPENAI_RESPONSE);
    const b = await discoverOpenAIModels(specWithModes, cfg);

    expect(b.length).toBe(OPENAI_RESPONSE.data.length * 2);
    expect(b.map((m) => m.mode)).toEqual(['normal', 'coding', 'normal', 'coding', 'normal', 'coding']);
  });

  it('(b) moonshot: filterPrefixes drops non kimi-/moonshot- ids', async () => {
    const MOONSHOT_RESPONSE = {
      data: [
        { id: 'kimi-k2-0711-preview' },
        { id: 'moonshot-v1-128k' },
        { id: 'text-embedding-3-large' }, // dropped — no allowed prefix
        { id: 'whisper-1' }, // dropped
      ],
    };
    const cfg = baseCfg({
      kind: 'moonshot',
      base_url: 'https://api.moonshot.ai/v1',
      api_key: 'k',
    });

    stubFetch(MOONSHOT_RESPONSE);
    const b = await discoverOpenAIModels(moonshotSpec, cfg);

    expect(b.map((m) => m.model_id)).toEqual(['kimi-k2-0711-preview', 'moonshot-v1-128k']);
  });

  it('(c) zai: hits the spec modelsUrl and returns the live list (new capability)', async () => {
    const ZAI_RESPONSE = { data: [{ id: 'glm-4.6' }, { id: 'glm-4.5-air' }] };
    const cfg = baseCfg({ kind: 'zai', api_key: 'k' });

    const stub = stubFetch(ZAI_RESPONSE);
    const out = await discoverOpenAIModels(zaiSpec, cfg);

    // No extra.zai_has_coding_mode -> no mode duplication, plain list.
    expect(out).toEqual([
      {
        model_id: 'glm-4.6',
        name: 'glm-4.6',
        context_window: out[0].context_window,
        source: 'live',
      },
      {
        model_id: 'glm-4.5-air',
        name: 'glm-4.5-air',
        context_window: out[1].context_window,
        source: 'live',
      },
    ]);
    // Hit the spec-declared discovery URL, not a base_url-derived one.
    expect(stub.calls).toEqual([zaiSpec.discovery!.modelsUrl]);
  });

  it('(c) mistral: keeps only models that advertise chat completions', async () => {
    const cfg = baseCfg({
      kind: 'mistral',
      base_url: 'https://api.mistral.ai/v1',
      api_key: 'k',
    });
    stubFetch({
      data: [
        { id: 'mistral-small-latest', capabilities: { completion_chat: true } },
        { id: 'codestral-embed-latest', capabilities: { completion_chat: false } },
        { id: 'mistral-ocr-latest', capabilities: { completion_chat: false } },
        { id: 'legacy-row-without-capabilities' },
      ],
    });

    const out = await discoverOpenAIModels(mistralSpec, cfg);

    expect(out.map((m) => m.model_id)).toEqual(['mistral-small-latest']);
  });
});

describe('discoverOpenAIModels spec.models gap-fill overlay', () => {
  it('(d) fugu: overlays reasoning levels + context window from spec.models onto live ids', async () => {
    // Fugu's /v1/models returns only ids; the reasoning levels live in spec.models.
    const FUGU_RESPONSE = { data: [{ id: 'fugu' }, { id: 'fugu-ultra' }] };
    const cfg = baseCfg({ kind: 'fugu', base_url: 'https://api.sakana.ai/v1', api_key: 'k' });

    stubFetch(FUGU_RESPONSE);
    const out = await discoverOpenAIModels(fuguSpec, cfg);

    expect(out).toHaveLength(2);
    for (const row of out) {
      expect(row.supported_reasoning_levels).toEqual(['high', 'xhigh', 'max']);
      expect(row.default_reasoning_level).toBe('xhigh');
      expect(row.context_window).toBe(272_000);
      expect(row.source).toBe('live');
    }
  });

  it('(d) ids absent from spec.models pass through untouched', async () => {
    // A live id the spec doesn't describe keeps the bare shape (no reasoning meta).
    const RESPONSE = { data: [{ id: 'fugu' }, { id: 'fugu-experimental' }] };
    const cfg = baseCfg({ kind: 'fugu', base_url: 'https://api.sakana.ai/v1', api_key: 'k' });

    stubFetch(RESPONSE);
    const out = await discoverOpenAIModels(fuguSpec, cfg);

    const experimental = out.find((m) => m.model_id === 'fugu-experimental')!;
    expect(experimental.supported_reasoning_levels).toBeUndefined();
    expect(experimental.default_reasoning_level).toBeUndefined();
  });

  it('(d) a spec WITHOUT models is inert (no reasoning fields added)', async () => {
    // Guards the blast radius: every existing openai-compat provider omits
    // spec.models, so the overlay must leave their rows byte-identical.
    const RESPONSE = { data: [{ id: 'gpt-4o' }] };
    const cfg = baseCfg({ base_url: 'https://api.openai.com/v1', api_key: 'k' });

    stubFetch(RESPONSE);
    const out = await discoverOpenAIModels(openaiSpec, cfg);

    expect(out[0]).not.toHaveProperty('supported_reasoning_levels');
    expect(out[0]).not.toHaveProperty('default_reasoning_level');
  });
});
