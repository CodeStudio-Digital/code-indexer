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

  it('does not let an older in-flight inventory satisfy a newer live refresh', async () => {
    const pending: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      pending.push(resolve);
    }));
    vi.stubGlobal('fetch', fetchMock);

    const stale = fetchSnapshotList('coder', 'session-a', {
      includeClosed: true,
      refreshKey: 0,
    });
    const fresh = fetchSnapshotList('coder', 'session-a', {
      includeClosed: true,
      refreshKey: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    pending[1]!(new Response(JSON.stringify({ files: [{ baselineId: 'fresh' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    pending[0]!(new Response(JSON.stringify({ files: [{ baselineId: 'stale' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(fresh).resolves.toEqual({ files: [{ baselineId: 'fresh' }] });
    await expect(stale).resolves.toEqual({ files: [{ baselineId: 'stale' }] });
  });
});
