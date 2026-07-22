/**
 * Regression — openStream cursor + replay-gap semantics:
 *
 *  B3: the reattach cursor commits only AFTER the event's handler ran, so
 *      a handler crash leaves the cursor behind and the next reconnect
 *      replays the event instead of losing it. Unparseable payloads still
 *      commit immediately (poison-pill protection) and now warn.
 *  B4: a `bus_info` preamble reporting evicted replay events surfaces a
 *      worker-log entry — `warn` when the eviction overlaps our cursor
 *      (permanent gap in the live view), `info` on a fresh attach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStream, type OpenStreamDeps } from '../openStream.js';
import { peekWorkerLog, noteWorkerLogBus, __resetWorkerLogForTests } from '../worker-log-store.js';

const enc = new TextEncoder();

// Controlled handler map: `boom` crashes, everything else has no handler
// (commitCursor must still run for handler-less events).
vi.mock('../handlers.js', () => ({
  createEventHandlers: () => ({
    boom: () => { throw new Error('handler crashed'); },
  }),
}));

function sse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function deps(): OpenStreamDeps {
  return {
    updateSession: vi.fn(),
    abortMap: new Map(),
    lastSeenSeqMap: new Map(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // openStream batches flushes via rAF — run the callback synchronously.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  __resetWorkerLogForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('openStream cursor semantics (B3)', () => {
  it('does not commit the cursor for an event whose handler throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      'id: 0\nevent: boom\ndata: {}\n\n',
    ])));
    const d = deps();
    const p = openStream(1, { url: '/api/coder/sessions/1/attach', method: 'GET', reattach: true }, d);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    // The handler crashed before commitCursor — the event must be replayed
    // on the next reconnect instead of being skipped.
    expect(d.lastSeenSeqMap.get(1)).toBeUndefined();
  });

  it('commits the cursor for unparseable payloads (poison-pill protection) and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      'id: 0\nevent: text\ndata: {broken json\n\n',
      'id: 1\nevent: done\ndata: {}\n\n',
    ])));
    const d = deps();
    const p = openStream(1, { url: '/api/coder/sessions/1/attach', method: 'GET', reattach: true }, d);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(d.lastSeenSeqMap.get(1)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      '[agent-stream] dropping malformed event payload',
      { event: 'text', id: 0 },
    );
  });
});

describe('openStream replay-gap visibility (B4)', () => {
  it('warns when the server evicted events ahead of our cursor', async () => {
    // Simulate an earlier connection to the SAME bus so the bus_info does
    // not reset the cursor (noteWorkerLogBus returns false on repeat).
    noteWorkerLogBus(1, 'b1');
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      'event: bus_info\ndata: {"bus_id":"b1","first_replay_seq":10,"dropped_replay_events":7}\n\n',
      'id: 10\nevent: done\ndata: {}\n\n',
    ])));
    const d = deps();
    const p = openStream(
      1,
      { url: '/api/coder/sessions/1/attach', method: 'GET', reattach: true, lastEventId: 3 },
      d,
    );
    await vi.advanceTimersByTimeAsync(10);
    await p;
    const gap = peekWorkerLog(1).find((e) => e.event === 'replay_gap');
    expect(gap).toBeDefined();
    expect(gap?.level).toBe('warn');
    expect(gap?.message).toContain('7');
  });

  it('logs info (not warn) on a fresh attach with evictions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      'event: bus_info\ndata: {"bus_id":"b2","first_replay_seq":4,"dropped_replay_events":4}\n\n',
      'id: 4\nevent: done\ndata: {}\n\n',
    ])));
    const d = deps();
    const p = openStream(1, { url: '/api/coder/sessions/1/attach', method: 'GET', reattach: true }, d);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    const gap = peekWorkerLog(1).find((e) => e.event === 'replay_gap');
    expect(gap).toBeDefined();
    expect(gap?.level).toBe('info');
  });

  it('stays silent when nothing was evicted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      'event: bus_info\ndata: {"bus_id":"b3","first_replay_seq":0,"dropped_replay_events":0}\n\n',
      'id: 0\nevent: done\ndata: {}\n\n',
    ])));
    const d = deps();
    const p = openStream(1, { url: '/api/coder/sessions/1/attach', method: 'GET', reattach: true }, d);
    await vi.advanceTimersByTimeAsync(10);
    await p;
    expect(peekWorkerLog(1).find((e) => e.event === 'replay_gap')).toBeUndefined();
  });
});
