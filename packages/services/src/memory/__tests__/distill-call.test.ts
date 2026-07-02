/**
 * distill-call — the typed LLM transport for the memory distillers.
 * Covers the regression that kept the pipeline dead: transport failures
 * (HTTP 401, empty text) must THROW a typed error instead of parsing as
 * "no facts"; the clamp keeps a starved binding config from truncating the
 * JSON; the runtime fallback retries a broken bound provider on the general
 * default; and the parser caps candidates (quality over quantity).
 */
import { describe, expect, it } from 'vitest';
import type { PipelineProviderResolver, ResolvedBinding } from '../../pipelines/index.js';
import {
  DistillLlmError,
  assertParsableDistillResponse,
  callDistillLlm,
  classifyEmptyParse,
  parseMemoryCandidates,
  MAX_CANDIDATES_PER_PASS,
} from '../distill-call.js';
import type { ChatCallOptions, ChatCallResult, ChatMessage } from '../../quality/llm-chat.js';

function binding(over: Partial<ResolvedBinding> = {}): ResolvedBinding {
  return {
    pipelineName: 'memory_extraction',
    bindingRole: 'distiller',
    provider: { id: 'zai', kind: 'zai', name: 'zai', api_key: 'k' } as ResolvedBinding['provider'],
    modelId: 'glm-4.7-flash',
    modelMode: '',
    config: {},
    resolvedFrom: 'global',
    bindingId: 1,
    ...over,
  };
}

function resolverFor(b: ResolvedBinding | null, fallback?: ResolvedBinding | null): PipelineProviderResolver {
  // resolveChain returns the failover chain the resolver would build: the
  // bound binding first, then the general default appended (distinct provider).
  const chain = b ? (fallback ? [b, fallback] : [b]) : fallback ? [fallback] : [];
  return {
    resolveChain: async () => chain,
    resolveOrNull: async () => b,
    resolveFallbackOnly: () => fallback ?? null,
  } as unknown as PipelineProviderResolver;
}

type ChatFn = (b: ResolvedBinding, m: ChatMessage[], o: ChatCallOptions) => Promise<ChatCallResult>;
const chat = (result: Partial<ChatCallResult>): ChatFn =>
  async () => ({ content: '', latencyMs: 5, ...result });

const MSGS: ChatMessage[] = [{ role: 'user', content: 'x' }];

describe('callDistillLlm', () => {
  it('HTTP error → throws DistillLlmError with llm_error + status', async () => {
    await expect(
      callDistillLlm(
        { resolver: resolverFor(binding()), chatFn: chat({ errorBody: 'unauthorized', status: 401 }) },
        MSGS,
      ),
    ).rejects.toMatchObject({ name: 'DistillLlmError', diag: { outcome: 'llm_error', httpStatus: 401 } });
  });

  it('empty text (thinking-only / dead call) → llm_error, never "no facts"', async () => {
    await expect(
      callDistillLlm({ resolver: resolverFor(binding()), chatFn: chat({ content: '   ' }) }, MSGS),
    ).rejects.toMatchObject({ diag: { outcome: 'llm_error' } });
  });

  it('no binding at all → llm_error with a useful snippet', async () => {
    await expect(
      callDistillLlm({ resolver: resolverFor(null), chatFn: chat({ content: '[]' }) }, MSGS),
    ).rejects.toMatchObject({ diag: { outcome: 'llm_error' } });
  });

  it('success → content + ok diag with provider/model', async () => {
    const { content, diag } = await callDistillLlm(
      { resolver: resolverFor(binding()), chatFn: chat({ content: '[]' }) },
      MSGS,
    );
    expect(content).toBe('[]');
    expect(diag).toMatchObject({ outcome: 'ok', providerId: 'zai', modelId: 'glm-4.7-flash' });
  });

  it('clamps maxTokens to ≥2000 (the live binding shipped with 1200)', async () => {
    let seen: number | undefined;
    const spy: ChatFn = async (_b, _m, o) => { seen = o.maxTokens; return { content: '[]', latencyMs: 1 }; };
    await callDistillLlm(
      { resolver: resolverFor(binding({ config: { max_tokens: 1200 } })), chatFn: spy },
      MSGS,
    );
    expect(seen).toBe(2000);
  });

  it('bound provider fails → one-shot retry on the general default (fallbackUsed)', async () => {
    const fb = binding({ provider: { id: 'openrouter', kind: 'openrouter', name: 'or', api_key: 'k' } as ResolvedBinding['provider'], resolvedFrom: 'fallback' });
    let calls = 0;
    const failThenOk: ChatFn = async (b) => {
      calls++;
      return b.provider.id === 'zai'
        ? { content: '', errorBody: 'boom', status: 500, latencyMs: 1 }
        : { content: '[{"title":"t","content":"c","category":"decision","importance":0.8}]', latencyMs: 1 };
    };
    const { diag } = await callDistillLlm(
      {
        resolver: resolverFor(binding(), fb),
        getFallbackDefault: () => ({ providerKind: 'openrouter', modelId: 'x' }),
        chatFn: failThenOk,
      },
      MSGS,
    );
    expect(calls).toBe(2);
    expect(diag).toMatchObject({ outcome: 'ok', fallbackUsed: true, providerId: 'openrouter' });
  });

  it('a binding that ALREADY resolved from fallback does not retry itself', async () => {
    await expect(
      callDistillLlm(
        {
          resolver: resolverFor(binding({ resolvedFrom: 'fallback' })),
          getFallbackDefault: () => ({ providerKind: 'zai', modelId: 'x' }),
          chatFn: chat({ errorBody: 'boom' }),
        },
        MSGS,
      ),
    ).rejects.toBeInstanceOf(DistillLlmError);
  });
});

describe('classifyEmptyParse / assertParsableDistillResponse', () => {
  it('bare [] is a genuine no_facts', () => {
    expect(classifyEmptyParse('[]')).toBe('no_facts');
    expect(classifyEmptyParse('```json\n[]\n```')).toBe('no_facts');
    expect(() => assertParsableDistillResponse('[]', 0, { outcome: 'ok', rawChars: 2, latencyMs: 1 })).not.toThrow();
  });

  it('prose / bad JSON / malformed items are parse_empty (retryable failure)', () => {
    expect(classifyEmptyParse('I could not find anything durable.')).toBe('parse_empty');
    expect(classifyEmptyParse('[{"title": }]')).toBe('parse_empty');
    expect(classifyEmptyParse('[{"noTitle":true}]')).toBe('parse_empty');
    expect(() =>
      assertParsableDistillResponse('nope', 0, { outcome: 'ok', rawChars: 4, latencyMs: 1 }),
    ).toThrowError(DistillLlmError);
  });

  it('parsed candidates present → no throw regardless of text shape', () => {
    expect(() =>
      assertParsableDistillResponse('whatever', 2, { outcome: 'ok', rawChars: 8, latencyMs: 1 }),
    ).not.toThrow();
  });
});

describe('parseMemoryCandidates cap', () => {
  it(`keeps at most ${MAX_CANDIDATES_PER_PASS} candidates (quality over quantity)`, () => {
    const many = JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, content: `c${i}`, category: 'note', importance: 0.5 })),
    );
    expect(parseMemoryCandidates(many)).toHaveLength(MAX_CANDIDATES_PER_PASS);
  });
});
