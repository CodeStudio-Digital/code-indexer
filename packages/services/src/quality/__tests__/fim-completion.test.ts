import { describe, it, expect, vi } from 'vitest';
import type { ResolvedBinding } from '../../pipelines/index.js';
import { supportsFim, fimCompletion, markFimUnsupported } from '../fim-completion.js';

function binding(over: { kind?: string; model?: string; config?: Record<string, unknown>; baseUrl?: string } = {}): ResolvedBinding {
  return {
    modelId: over.model ?? 'deepseek-chat',
    config: over.config ?? {},
    provider: {
      id: 'p', name: 'P', kind: over.kind ?? 'deepseek',
      api_key: 'sk-test', base_url: over.baseUrl, extra: {},
    },
  } as unknown as ResolvedBinding;
}

function jsonFetch(payload: unknown, status = 200) {
  return vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status })));
}

describe('supportsFim', () => {
  it('enables for the deepseek kind and known FIM model ids', () => {
    expect(supportsFim(binding({ kind: 'deepseek' }))).toBe(true);
    expect(supportsFim(binding({ kind: 'openrouter', model: 'qwen2.5-coder-32b' }))).toBe(true);
    expect(supportsFim(binding({ kind: 'openrouter', model: 'codestral-latest' }))).toBe(true);
  });
  it('disables for a generic chat model, respects explicit config', () => {
    expect(supportsFim(binding({ kind: 'openai', model: 'gpt-4o' }))).toBe(false);
    expect(supportsFim(binding({ kind: 'deepseek', config: { fim: false } }))).toBe(false);
    expect(supportsFim(binding({ kind: 'openai', model: 'gpt-4o', config: { fim: true } }))).toBe(true);
  });
  it('excludes reasoning models even on a FIM-capable provider', () => {
    expect(supportsFim(binding({ kind: 'deepseek', model: 'deepseek-reasoner' }))).toBe(false);
    expect(supportsFim(binding({ kind: 'deepseek', model: 'deepseek-r1' }))).toBe(false);
  });
  it('stops choosing FIM after the endpoint is marked unsupported', () => {
    const b = binding({ kind: 'deepseek', model: 'deepseek-coder' });
    expect(supportsFim(b)).toBe(true);
    markFimUnsupported(b);
    expect(supportsFim(b)).toBe(false);
    // A different model on the same provider is unaffected.
    expect(supportsFim(binding({ kind: 'deepseek', model: 'deepseek-chat' }))).toBe(true);
  });
});

describe('fimCompletion', () => {
  it('posts prompt+suffix to the DeepSeek /beta/completions endpoint', async () => {
    const fetchFn = jsonFetch({ choices: [{ text: 'count();' }] });
    const r = await fimCompletion(
      binding({ kind: 'deepseek', model: 'deepseek-coder' }),
      { prefix: 'LoyaltyServiceModel::', suffix: '\n}', context: '### Scope\nInside method x().', language: 'php' },
      { fetchFn: fetchFn as unknown as typeof fetch, maxTokens: 256 },
    );
    expect(r.content).toBe('count();');
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/beta/completions');
    const sent = JSON.parse(init!.body as string);
    expect(sent.suffix).toBe('\n}');
    expect(sent.prompt).toContain('// ### Scope');           // context commented (php → //)
    expect(sent.prompt.endsWith('LoyaltyServiceModel::')).toBe(true);
  });

  it('comments the context with # for python', async () => {
    const fetchFn = jsonFetch({ choices: [{ text: 'x' }] });
    await fimCompletion(
      binding({ kind: 'deepseek' }),
      { prefix: 'self.', suffix: '', context: 'scope line', language: 'python' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    const sent = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(sent.prompt).toContain('# scope line');
  });

  it('returns errorBody + status on a non-2xx (caller degrades to chat)', async () => {
    const fetchFn = jsonFetch('no such endpoint', 404);
    const r = await fimCompletion(
      binding({ kind: 'deepseek' }),
      { prefix: 'a', suffix: 'b', context: '', language: 'ts' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(r.content).toBe('');
    expect(r.status).toBe(404);
    expect(r.errorBody).toContain('no such endpoint');
  });
});
