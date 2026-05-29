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

type RerankerCfg = { kind: string; config: Record<string, unknown> } | null;

function storeWith(cfg: RerankerCfg) {
  return { getDefaultReranker: () => cfg };
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
});
