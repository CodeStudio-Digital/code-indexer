/**
 * Moonshot AI Open Platform provider definition.
 *
 * Distinct from kimi-code (OAuth) — uses static API keys against the
 * api.moonshot.ai/v1 (or .cn/v1) endpoints. Reuses the KimiCode adapter
 * classes for wire compatibility (thinking-mode, reasoning streaming,
 * tool-schema normalization).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatCalls: Array<Record<string, unknown>> = [];
const indexerCalls: Array<{
  apiKey?: string;
  model?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}> = [];

vi.mock('@mcp/code-agent/providers/kimi-code.js', () => ({
  KimiCodeChatProvider: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    opts: Record<string, unknown>,
  ) {
    chatCalls.push(opts);
    Object.assign(this, opts);
  }),
}));

vi.mock('@mcp/indexer/indexer/providers/kimi-code.js', () => ({
  KimiCodeProvider: vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    apiKey?: string,
    model?: string,
    baseURL?: string,
    defaultHeaders?: Record<string, string>,
  ) {
    indexerCalls.push({ apiKey, model, baseURL, defaultHeaders });
    Object.assign(this, { apiKey, model, baseURL, defaultHeaders });
  }),
}));

import { moonshot } from '@mcp/services/providers/definitions/moonshot.js';
import type { ResolvedCreds } from '@mcp/services/providers/types.js';

beforeEach(() => {
  chatCalls.length = 0;
  indexerCalls.length = 0;
});

describe('moonshot provider definition', () => {
  it('declares the registry-required fields', () => {
    expect(moonshot.kind).toBe('moonshot');
    expect(moonshot.credKind).toBe('api-key');
    expect(moonshot.envVars).toEqual(['MOONSHOT_API_KEY', 'KIMI_API_KEY']);
    expect(moonshot.defaultBaseURL).toBe('https://api.moonshot.ai/v1');
    expect(moonshot.defaultModels.length).toBeGreaterThan(0);
  });

  it('is registered alongside kimi-code without colliding', async () => {
    const { getDefinition, listCoderKinds, listIndexerKinds } = await import(
      '@mcp/services/providers/registry.js'
    );
    expect(getDefinition('moonshot')).toBeDefined();
    expect(getDefinition('kimi-code')).toBeDefined();
    expect(listCoderKinds()).toContain('moonshot');
    expect(listIndexerKinds()).toContain('moonshot');
  });
});

describe('moonshot.createCoder', () => {
  it('uses defaultBaseURL when creds.baseURL is absent', () => {
    moonshot.createCoder!({ apiKey: 'sk-test' }, 'kimi-k2-turbo-preview');
    expect(chatCalls[0].baseURL).toBe('https://api.moonshot.ai/v1');
    expect(chatCalls[0].apiKey).toBe('sk-test');
    expect(chatCalls[0].model).toBe('kimi-k2-turbo-preview');
  });

  it('honors a custom baseURL (e.g., moonshot.cn or kimi-code static-key)', () => {
    moonshot.createCoder!(
      { apiKey: 'sk-test', baseURL: 'https://api.moonshot.cn/v1' },
      'kimi-latest',
    );
    expect(chatCalls[0].baseURL).toBe('https://api.moonshot.cn/v1');
  });

  it('forwards thinkingMode from extra.kimi_code_thinking_mode', () => {
    moonshot.createCoder!(
      { apiKey: 'sk-test', extra: { kimi_code_thinking_mode: 'enabled' } },
      'kimi-k2-thinking-turbo',
    );
    expect(chatCalls[0].thinkingMode).toBe('enabled');
  });

  it('defaults thinkingMode to "auto" when extra is empty or invalid', () => {
    moonshot.createCoder!({ apiKey: 'sk-test' }, 'kimi-latest');
    expect(chatCalls[0].thinkingMode).toBe('auto');
    moonshot.createCoder!(
      { apiKey: 'sk-test', extra: { kimi_code_thinking_mode: 'garbage' } },
      'kimi-latest',
    );
    expect(chatCalls[1].thinkingMode).toBe('auto');
  });
});

describe('moonshot.createIndexer', () => {
  it('builds the same baseURL and forwards apiKey/model', () => {
    const creds: ResolvedCreds = { apiKey: 'sk-test' };
    moonshot.createIndexer!(creds, 'kimi-k2-0711-preview');
    expect(indexerCalls[0].baseURL).toBe('https://api.moonshot.ai/v1');
    expect(indexerCalls[0].apiKey).toBe('sk-test');
    expect(indexerCalls[0].model).toBe('kimi-k2-0711-preview');
  });
});

describe('discoverMoonshot', () => {
  const baseCfg = {
    id: 'moonshot-instance',
    name: 'Moonshot',
    kind: 'moonshot' as const,
    base_url: null,
    api_key: 'sk-test',
    auth_mode: 'api_key' as const,
    enabled: true,
    use_for_agent: true,
    use_for_coder: true,
    use_for_general: false,
    is_default: false,
    extra: {},
    fallback_provider_id: null,
    created_at: '',
    updated_at: '',
  };

  it('hits {default base}/models with the bearer token and filters to kimi-/moonshot- prefixes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          data: [
            { id: 'kimi-k2-0711-preview' },
            { id: 'kimi-latest' },
            { id: 'moonshot-v1-128k' },
            { id: 'unrelated-model' },
            { id: 'embedding-2' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { discoverMoonshot } = await import(
        '@apps/http-api/admin/model-discovery/moonshot.js'
      );
      const models = await discoverMoonshot(baseCfg);
      expect(calls[0].url).toBe('https://api.moonshot.ai/v1/models');
      expect((calls[0].init?.headers as Record<string, string>)?.Authorization).toBe(
        'Bearer sk-test',
      );
      const ids = models.map((m) => m.model_id);
      expect(ids).toContain('kimi-k2-0711-preview');
      expect(ids).toContain('kimi-latest');
      expect(ids).toContain('moonshot-v1-128k');
      expect(ids).not.toContain('unrelated-model');
      expect(ids).not.toContain('embedding-2');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('respects cfg.base_url override (moonshot.cn)', async () => {
    const calls: Array<{ url: string }> = [];
    const fetchMock = vi.fn(async (url: unknown) => {
      calls.push({ url: String(url) });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { discoverMoonshot } = await import(
        '@apps/http-api/admin/model-discovery/moonshot.js'
      );
      await discoverMoonshot({ ...baseCfg, base_url: 'https://api.moonshot.cn/v1/' });
      expect(calls[0].url).toBe('https://api.moonshot.cn/v1/models');
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('throws on non-2xx responses', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { discoverMoonshot } = await import(
        '@apps/http-api/admin/model-discovery/moonshot.js'
      );
      await expect(discoverMoonshot(baseCfg)).rejects.toThrow(/HTTP 403/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
