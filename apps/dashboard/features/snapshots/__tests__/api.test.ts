import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSnapshotList } from '../api.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('snapshot list transport', () => {
  it('collapses concurrent refreshes for the same session into one request', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = fetchSnapshotList('coder', 'session-a', {
      includeClosed: true,
    });
    const second = fetchSnapshotList('coder', 'session-a', {
      includeClosed: true,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    resolveFetch(new Response(JSON.stringify({ files: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { files: [] },
      { files: [] },
    ]);

    const third = fetchSnapshotList('coder', 'session-a', {
      includeClosed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveFetch(new Response(JSON.stringify({ files: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await third;
  });
});
