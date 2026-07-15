import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchPackages } from '../package-search.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('searchPackages', () => {
  it('maps Maven Central results to the stable package shape', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({
      response: { docs: [{ id: 'org.slf4j:slf4j-api', latestVersion: '2.0.17' }, { id: 'broken' }] },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchPackages('maven', 'slf4j', Number.NaN)).resolves.toEqual([
      { id: 'org.slf4j:slf4j-api', version: '2.0.17' },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('rows=12');
  });

  it('maps NuGet results and normalizes descriptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'Newtonsoft.Json', version: '13.0.3', description: ' JSON\n framework  ' }],
    }), { status: 200 })));

    await expect(searchPackages('dotnet', 'json', 99)).resolves.toEqual([
      { id: 'Newtonsoft.Json', version: '13.0.3', description: 'JSON framework' },
    ]);
  });

  it('aborts an unresponsive registry after the bounded timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));

    const pending = searchPackages('gradle', 'kotlin');
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(8_001);
    await rejection;
  });
});
