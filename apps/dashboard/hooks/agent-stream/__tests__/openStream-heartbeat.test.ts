import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStream, type OpenStreamDeps } from '../openStream.js';
import { __resetWorkerLogForTests, peekWorkerLog } from '../worker-log-store.js';

const enc = new TextEncoder();
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function heartbeatThenDone(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode([
        'event: ping\ndata: 1\n\n',
        'event: ping\ndata: 2\n\n',
        'event: done\ndata: {}\n\n',
      ].join('')));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function deps(): OpenStreamDeps {
  return {
    updateSession: vi.fn(),
    abortMap: new Map(),
    lastSeenSeqMap: new Map(),
    lastSeenBusIdMap: new Map(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-23T15:00:00.000Z'));
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  __resetWorkerLogForTests();
});

afterEach(() => {
  __resetWorkerLogForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('openStream transport heartbeat', () => {
  const attach = { url: `/api/coder/sessions/${SESSION_ID}/attach`, method: 'GET' as const, reattach: true };

  it('waits through a failed state probe and a live-worker attach race, then displays the real worker error', async () => {
    let probes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/state')) {
        if (++probes === 1) throw new TypeError('offline');
        return Response.json({ alive: true, status: 'running' });
      }
      if (probes < 2) return Response.json({ error: 'no active run' }, { status: 404 });
      return new Response('event: error\ndata: {"message":"worker fixture failed"}\n\n');
    }));
    const d = deps();
    const complete = vi.fn();
    const p = openStream(SESSION_ID, attach, d, complete);
    await vi.advanceTimersByTimeAsync(1500);
    expect(d.abortMap.has(SESSION_ID)).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(d.updateSession).toHaveBeenCalledWith(SESSION_ID, { reconnecting: true });
    await vi.runAllTimersAsync();
    await p;
    expect(d.updateSession).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ error: 'worker fixture failed' }));
    expect(d.abortMap.has(SESSION_ID)).toBe(false);
  });

  it('stops a hanging diagnostic immediately when its owner is replaced', async () => {
    let resolveProbe!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/state')) return new Promise<Response>(resolve => { resolveProbe = resolve; });
      return Response.json({}, { status: 404 });
    }));
    const d = deps();
    const complete = vi.fn();
    const old = openStream(SESSION_ID, attach, d, complete);
    await vi.advanceTimersByTimeAsync(1);
    const first = d.abortMap.get(SESSION_ID)!;
    const replacement = new AbortController();
    d.abortMap.set(SESSION_ID, replacement);
    first.abort();
    await old;
    resolveProbe(Response.json({ alive: false, status: 'completed' }));
    await vi.runAllTimersAsync();
    expect(d.abortMap.get(SESSION_ID)).toBe(replacement);
    expect(complete).not.toHaveBeenCalled();
    expect(d.updateSession).not.toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ streaming: false }));
  });

  it('reloads the saved transcript when the server returns an exact command receipt after a disconnect', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('peer closed', 'AbortError'))
      .mockResolvedValueOnce(new Response('event: done\ndata: {"reason":"completed","duplicate":true,"persisted":true}\n\n'));
    vi.stubGlobal('fetch', fetchMock);
    const complete = vi.fn();
    const d = deps();
    const p = openStream(SESSION_ID, {
      method: 'POST', url: `/api/coder/sessions/${SESSION_ID}/messages`, body: { content: 'continue' },
    }, d, complete);
    await vi.runAllTimersAsync();
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledOnce();
    expect(d.updateSession).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ doneReason: 'completed' }));
  });

  it('refreshes lastEventAt once per throttle window without logging or cursoring ping', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => heartbeatThenDone()));
    const d = deps();

    const pending = openStream(
      SESSION_ID,
      { url: `/api/coder/sessions/${SESSION_ID}/attach`, method: 'GET', reattach: true },
      d,
    );
    await vi.runAllTimersAsync();
    await pending;

    const livenessPatches = vi.mocked(d.updateSession).mock.calls
      .map(([, patch]) => patch)
      .filter((patch) =>
        typeof patch !== 'function'
        && typeof patch.lastEventAt === 'number');

    expect(livenessPatches).toEqual([
      { lastEventAt: Date.parse('2026-07-23T15:00:00.000Z') },
    ]);
    expect(d.lastSeenSeqMap.size).toBe(0);
    expect(peekWorkerLog(SESSION_ID).some((entry) => entry.event === 'ping')).toBe(false);
  });
});
