/**
 * Verifies the chunked event pump in openStream: a reattach replay burst is
 * enqueued off the arrival tick and drained in ordered batches (yielding the
 * event loop in between), while the (busId, hwm) worker-log dedup and the
 * Last-Event-ID cursor keep their exact semantics, and an abort discards the
 * pending queue instead of pumping a detached session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStream, type OpenStreamDeps } from '../openStream.js';
import { __resetWorkerLogForTests, peekWorkerLog } from '../worker-log-store.js';

const enc = new TextEncoder();

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(frames.join('')));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const busInfoFrame = (busId: string): string =>
  `event: bus_info\ndata: ${JSON.stringify({ bus_id: busId })}\n\n`;

const workerLogFrame = (id: number, message: string): string =>
  `id: ${id}\nevent: worker_log\ndata: ${JSON.stringify({ ts: 1, level: 'info', category: 'runner', message })}\n\n`;

const doneFrame = (id: number): string => `id: ${id}\nevent: done\ndata: {}\n\n`;

function deps(): OpenStreamDeps {
  return {
    updateSession: vi.fn(),
    abortMap: new Map(),
    lastSeenSeqMap: new Map(),
  };
}

/** Let the stubbed fetch + ReadableStream reads settle without firing timers,
 * so we can observe the state of the pump strictly ON the arrival tick. */
async function flushMicrotasks(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

const attachOpts = { url: '/api/coder/sessions/1/attach', method: 'GET', reattach: true } as const;

beforeEach(() => {
  vi.useFakeTimers();
  // Node test env has no rAF. A never-firing stub routes both openStream's
  // flush and the worker-log store commit through their setTimeout fallbacks,
  // which the fake timers control deterministically. The pump's yield falls
  // back to setTimeout(0) too (no global scheduler in node).
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  __resetWorkerLogForTests();
});

afterEach(() => {
  __resetWorkerLogForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('openStream chunked replay pump', () => {
  it('defers a since=-1 replay burst off the arrival tick and drains it in order', async () => {
    const N = 120;
    const frames = [busInfoFrame('bus-a')];
    for (let i = 0; i < N; i++) frames.push(workerLogFrame(i, `e${i}`));
    frames.push(doneFrame(N));
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const d = deps();
    const p = openStream(1, attachOpts, d);
    await flushMicrotasks();
    // The whole burst is only ENQUEUED on the arrival tick — the cursor
    // advances per event at processing time, so an untouched map proves no
    // synchronous processing happened inside the SSE read loop.
    expect(d.lastSeenSeqMap.get(1)).toBeUndefined();

    await vi.runAllTimersAsync();
    await p;

    // Strict arrival order, nothing lost, terminal event included.
    const expected = [...Array.from({ length: N }, (_, i) => `e${i}`), 'done'];
    expect(peekWorkerLog(1).map((e) => e.message)).toEqual(expected);
    // Cursor caught up to the terminal frame once the drain finished.
    expect(d.lastSeenSeqMap.get(1)).toBe(N);
    // The burst really was chunked: multiple 0ms yields, not one giant batch
    // (122 events / EVENT_BATCH_SIZE=50 → at least 2 yields between batches).
    const zeroDelayYields = setTimeoutSpy.mock.calls.filter((c) => c[1] === 0).length;
    expect(zeroDelayYields).toBeGreaterThanOrEqual(2);
  });

  it('keeps the (busId, hwm) dedup intact across a remount-style full replay', async () => {
    // Run 1 — bus-a delivers seqs 0..2 plus done(3).
    const run1 = [
      busInfoFrame('bus-a'),
      workerLogFrame(0, 'r1-0'),
      workerLogFrame(1, 'r1-1'),
      workerLogFrame(2, 'r1-2'),
      doneFrame(3),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(run1)));
    const p1 = openStream(1, attachOpts, deps());
    await vi.runAllTimersAsync();
    await p1;

    // Remount: a fresh openStream reattaches with since=-1 on the SAME bus —
    // the server replays the buffered tail (dup seqs) plus newer events. The
    // bus_info preamble travels through the same queue as the data events,
    // so the (busKey, hwm) mark still swallows exactly the duplicates.
    const run2 = [
      busInfoFrame('bus-a'),
      workerLogFrame(0, 'replay-0'),
      workerLogFrame(1, 'replay-1'),
      workerLogFrame(2, 'replay-2'),
      workerLogFrame(4, 'r2-new'),
      doneFrame(5),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(run2)));
    const p2 = openStream(1, attachOpts, deps());
    await vi.runAllTimersAsync();
    await p2;

    expect(peekWorkerLog(1).map((e) => e.message)).toEqual([
      'r1-0', 'r1-1', 'r1-2', 'done', 'r2-new', 'done',
    ]);
  });

  it('discards the pending queue when the stream is aborted before the drain runs', async () => {
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        ctl = controller;
        const frames = [busInfoFrame('bus-a')];
        for (let i = 0; i < 10; i++) frames.push(workerLogFrame(i, `e${i}`));
        controller.enqueue(enc.encode(frames.join('')));
        // Stream intentionally left open — the run is still live.
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })));

    const d = deps();
    const p = openStream(1, attachOpts, d);
    await flushMicrotasks(); // burst enqueued; drain still parked on its first yield
    d.abortMap.get(1)!.abort(); // unmount / superseding openStream
    await vi.runAllTimersAsync();

    // Queue dropped wholesale: nothing processed, logged or cursor-advanced.
    expect(peekWorkerLog(1)).toHaveLength(0);
    expect(d.lastSeenSeqMap.size).toBe(0);

    ctl!.close(); // let the transport read loop end so openStream settles
    await p;
  });
});
