/**
 * Coverage for the `createReranker` factory — the store→env→Null priority
 * chain wired in migration 109 / provider-store. The reranker is applied
 * after the RRF merge; getting the factory selection right is what flips
 * reranking on for an install.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createReranker,
  NullReranker,
  CohereReranker,
  CloudflareReranker,
} from '../reranker.js';
import { LocalReranker } from '../local-reranker.js';

type RerankerCfg = { kind: string; config: Record<string, unknown> } | null;
type ProviderRow = { kind: string; base_url: string | null; api_key: string | null };

function storeWith(cfg: RerankerCfg, providers?: Record<string, ProviderRow>) {
  return {
    getDefaultReranker: () => cfg,
    getProvider: (id: string) => providers?.[id] ?? null,
  };
}

const ENV_KEYS = [
  'COHERE_API_KEY',
  'COHERE_RERANK_MODEL',
  'MCP_RERANK_WORKER_URL',
  'MCP_RERANK_WORKER_TOKEN',
] as const;

describe('createReranker', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('returns NullReranker when there is no store and no env', () => {
    expect(createReranker()).toBeInstanceOf(NullReranker);
    expect(createReranker(null)).toBeInstanceOf(NullReranker);
  });

  it('builds a LocalReranker from a local store config', () => {
    const r = createReranker(
      storeWith({ kind: 'local', config: { model: 'Xenova/bge-reranker-base' } }),
    );
    expect(r).toBeInstanceOf(LocalReranker);
    expect(r.name).toBe('local');
  });

  it('builds a LocalReranker even with empty config (model defaulted)', () => {
    const r = createReranker(storeWith({ kind: 'local', config: {} }));
    expect(r).toBeInstanceOf(LocalReranker);
  });

  it('builds a CohereReranker from a cohere store config', () => {
    const r = createReranker(
      storeWith({ kind: 'cohere', config: { apiKey: 'co-test', model: 'rerank-v3.5' } }),
    );
    expect(r).toBeInstanceOf(CohereReranker);
    expect(r.name).toBe('cohere');
  });

  it('builds a CloudflareReranker from a cloudflare store config', () => {
    const r = createReranker(
      storeWith({ kind: 'cloudflare', config: { workerUrl: 'https://w.example.dev', workerToken: 't' } }),
    );
    expect(r).toBeInstanceOf(CloudflareReranker);
    expect(r.name).toBe('cloudflare');
  });

  it('falls through when the store config is missing required fields', () => {
    // cohere without apiKey, cloudflare without workerUrl → neither builds,
    // and with no env we land on NullReranker.
    expect(createReranker(storeWith({ kind: 'cohere', config: {} }))).toBeInstanceOf(NullReranker);
    expect(createReranker(storeWith({ kind: 'cloudflare', config: {} }))).toBeInstanceOf(NullReranker);
  });

  it('falls back to env when the store has no default', () => {
    process.env.COHERE_API_KEY = 'co-env';
    expect(createReranker(storeWith(null))).toBeInstanceOf(CohereReranker);
  });

  it('prefers a valid store config over env', () => {
    process.env.MCP_RERANK_WORKER_URL = 'https://env.example.dev';
    const r = createReranker(storeWith({ kind: 'cohere', config: { apiKey: 'co-test' } }));
    expect(r).toBeInstanceOf(CohereReranker);
  });

  it('builds a provider reranker by reusing a configured provider key', () => {
    const r = createReranker(
      storeWith(
        { kind: 'provider', config: { providerId: 'openrouter' } },
        { openrouter: { kind: 'openrouter', base_url: null, api_key: 'or-test' } },
      ),
    );
    // Provider rerank reuses the Cohere-compatible client under a 'provider' name.
    expect(r).toBeInstanceOf(CohereReranker);
    expect(r.name).toBe('provider');
  });

  it('falls through to Null when the provider has no key or is unknown', () => {
    expect(
      createReranker(
        storeWith(
          { kind: 'provider', config: { providerId: 'openrouter' } },
          { openrouter: { kind: 'openrouter', base_url: null, api_key: null } },
        ),
      ),
    ).toBeInstanceOf(NullReranker);
    expect(
      createReranker(storeWith({ kind: 'provider', config: { providerId: 'nope' } }, {})),
    ).toBeInstanceOf(NullReranker);
  });

  it('falls through to Null when the provider kind is not OpenAI-compatible', () => {
    // Anthropic has no OpenAI-compatible base URL / rerank endpoint.
    expect(
      createReranker(
        storeWith(
          { kind: 'provider', config: { providerId: 'anthropic' } },
          { anthropic: { kind: 'anthropic', base_url: null, api_key: 'sk-ant' } },
        ),
      ),
    ).toBeInstanceOf(NullReranker);
  });

  it('provider reranker POSTs to {baseURL}/rerank with the configured model', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: { body: string }) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const r = createReranker(
        storeWith(
          { kind: 'provider', config: { providerId: 'or', model: 'nvidia/llama-nemotron-rerank-vl-1b-v2:free' } },
          { or: { kind: 'openrouter', base_url: null, api_key: 'or-key' } },
        ),
      );
      const out = await r.rerank('q', [{ id: 'a', text: 'doc', originalScore: 0.1 }], 5);
      // Default OpenRouter base URL → /rerank, free Nemotron model, mapped result.
      expect(calls[0].url).toBe('https://openrouter.ai/api/v1/rerank');
      expect(calls[0].body.model).toBe('nvidia/llama-nemotron-rerank-vl-1b-v2:free');
      expect(out[0]).toEqual({ id: 'a', score: 0.9, originalScore: 0.1 });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('provider reranker honors a custom base_url', async () => {
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const r = createReranker(
        storeWith(
          { kind: 'provider', config: { providerId: 'or' } },
          { or: { kind: 'openrouter', base_url: 'https://proxy.example/v1/', api_key: 'k' } },
        ),
      );
      await r.rerank('q', [{ id: 'a', text: 'doc', originalScore: 0.1 }], 5);
      // Trailing slash stripped; custom base wins over the default.
      expect(calls[0]).toBe('https://proxy.example/v1/rerank');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
