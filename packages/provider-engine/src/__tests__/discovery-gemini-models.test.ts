import { describe, it, expect, afterEach } from 'vitest';
import type { ProviderConfig } from '@mcp/store/provider-store.js';

import { discoverGeminiModels } from '../discovery/gemini-models.js';
import { geminiSpec } from '../specs/gemini.js';

/**
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

describe('discoverGeminiModels', () => {
  it('maps a representative Gemini response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(MODELS_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;

    const b = await discoverGeminiModels(geminiSpec, CFG);

    expect(b).toEqual([
      {
        model_id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        display_name: 'Gemini 2.5 Pro',
        context_window: 1_048_576,
        default_max_tokens: 65_536,
        can_reason: true,
        supported_reasoning_levels: ['low', 'medium', 'high'],
        default_reasoning_level: 'high',
        supports_attachments: true,
        input_modalities: ['text', 'image', 'audio', 'video'],
        visibility: 'list',
        supported_in_api: true,
        source: 'live',
      },
      {
        model_id: 'gemini-legacy',
        name: 'models/gemini-legacy',
        display_name: 'models/gemini-legacy',
        context_window: null,
        default_max_tokens: null,
        can_reason: false,
        supported_reasoning_levels: null,
        default_reasoning_level: null,
        supports_attachments: true,
        input_modalities: ['text', 'image', 'audio', 'video'],
        visibility: 'list',
        supported_in_api: true,
        source: 'live',
      },
    ]);
  });

  it('throws on a non-ok response', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 403 })) as typeof globalThis.fetch;

    await expect(discoverGeminiModels(geminiSpec, CFG)).rejects.toThrow('HTTP 403');
  });
});
