import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCompletionProbe } from '../completion/probe.js';

afterEach(() => vi.unstubAllGlobals());

describe('completion probe', () => {
  it('probes a provider/model before a pipeline binding exists', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      choices: [{ message: { content: 'value' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runCompletionProbe({
      pipelineProviderResolver: { resolveChain: vi.fn(() => { throw new Error('must not resolve bindings'); }) },
      providerStore: {
        getProvider: vi.fn(() => ({
          id: 'mistral-codestral', name: 'Mistral / Codestral', kind: 'mistral',
          api_key: 'test-only', base_url: 'https://api.mistral.ai/v1', enabled: true, extra: {},
        })),
      },
    } as never, { providerId: 'mistral-codestral', modelId: 'codestral-latest' });

    expect(result.ok).toBe(true);
    expect(result.samples).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.every(([url]) => url === 'https://api.mistral.ai/v1/fim/completions')).toBe(true);
  });

  it('keeps HTTP status in the safe probe result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const result = await runCompletionProbe({
      pipelineProviderResolver: { resolveChain: vi.fn() },
      providerStore: { getProvider: vi.fn(() => ({
        id: 'p', name: 'P', kind: 'mistral', api_key: 'test-only',
        base_url: 'https://api.mistral.ai/v1', enabled: true, extra: {},
      })) },
    } as never, { providerId: 'p', modelId: 'codestral-latest' });

    expect(result.ok).toBe(false);
    expect(result.samples.every((sample) => sample.status === 'http_404')).toBe(true);
    expect(result.message).toContain('http_404');
  });
});
