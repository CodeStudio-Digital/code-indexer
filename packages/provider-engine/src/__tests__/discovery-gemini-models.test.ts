import { describe, it, expect, afterEach } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

import { discoverGemini } from '@apps/http-api/admin/model-discovery/gemini.js';
import { discoverGeminiModels } from '../discovery/gemini-models.js';
import { geminiSpec } from '../specs/gemini.js';

/**
 * Equivalence guard for the `gemini-models` discovery lift: the declarative
 * `discoverGeminiModels(spec, cfg)` must return EXACTLY what the hand-written
 * admin `discoverGemini(cfg)` returns for the same upstream payload.
 *
 * The representative response covers the three branches the mapper cares about:
 *  - a model WITH `generateContent` and full token limits (kept, mapped),
 *  - a model with `supportedGenerationMethods` present but lacking
 *    `generateContent` (filtered out),
 *  - a model with NO `supportedGenerationMethods` at all (kept via the `?? true`
 *    fallback) and missing token limits (→ null fallbacks + displayName fallback
 *    to the raw `name`).
 */
const MODELS_RESPONSE = {
  models: [
    {
      name: 'models/gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/embedding-001',
      displayName: 'Embedding 001',
      inputTokenLimit: 2048,
      outputTokenLimit: 1,
      supportedGenerationMethods: ['embedContent'],
    },
    {
      // No supportedGenerationMethods and no token limits — exercises the
      // `?? true` keep + the `?? null` / displayName fallbacks.
      name: 'models/gemini-legacy',
    },
  ],
};

const CFG: ProviderConfig = {
  id: 'p1',
  name: 'Gemini',
  kind: 'gemini',
  base_url: null,
  api_key: 'k',
  auth_mode: 'api_key',
  enabled: true,
  use_for_agent: true,
  use_for_coder: true,
  use_for_general: true,
  is_default: false,
  extra: {},
  fallback_provider_id: null,
  created_at: '',
  updated_at: '',
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('discoverGeminiModels equivalence: engine(spec, cfg) == admin discoverGemini(cfg)', () => {
  it('returns an identical UpsertModelInput[] for a representative response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MODELS_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;

    const a = await discoverGemini(CFG);
    const b = await discoverGeminiModels(geminiSpec, CFG);

    expect(b).toEqual(a);

    // Sanity on the lifted shape: the embedding model is filtered, the other
    // two survive (one mapped fully, one through the null/displayName fallbacks).
    expect(b).toEqual([
      {
        model_id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        context_window: 1_048_576,
        default_max_tokens: 65_536,
        source: 'live',
      },
      {
        model_id: 'gemini-legacy',
        name: 'models/gemini-legacy',
        context_window: null,
        default_max_tokens: null,
        source: 'live',
      },
    ]);
  });

  it('both throw on a non-ok response', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 403 })) as typeof globalThis.fetch;

    await expect(discoverGemini(CFG)).rejects.toThrow('HTTP 403');

    globalThis.fetch = (async () => new Response('nope', { status: 403 })) as typeof globalThis.fetch;
    await expect(discoverGeminiModels(geminiSpec, CFG)).rejects.toThrow('HTTP 403');
  });
});
