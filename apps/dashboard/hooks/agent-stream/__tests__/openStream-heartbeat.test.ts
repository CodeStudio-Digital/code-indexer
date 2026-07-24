import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStream, type OpenStreamDeps } from '../openStream.js';
import { __resetWorkerLogForTests, peekWorkerLog } from '../worker-log-store.js';

const enc = new TextEncoder();

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
  it('refreshes lastEventAt once per throttle window without logging or cursoring ping', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => heartbeatThenDone()));
    const d = deps();

    const pending = openStream(
      1,
      { url: '/api/coder/sessions/1/attach', method: 'GET', reattach: true },
      d,
    );
    await vi.runAllTimersAsync();
    await pending;

    const livenessPatches = vi.mocked(d.updateSession).mock.calls
      .map(([, patch]) => patch)
      .filter((patch) =>
        typeof patch !== 'function'
        && Object.prototype.hasOwnProperty.call(patch, 'lastEventAt'));

    expect(livenessPatches).toEqual([
      { lastEventAt: Date.parse('2026-07-23T15:00:00.000Z') },
    ]);
    expect(d.lastSeenSeqMap.size).toBe(0);
    expect(peekWorkerLog(1).some((entry) => entry.event === 'ping')).toBe(false);
  });
});
