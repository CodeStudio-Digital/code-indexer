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
const SESSION_ID = '11111111-1111-4111-8111-111111111111';

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

const toolResultFrame = (id: number, toolUseId: string): string =>
  `id: ${id}\nevent: tool_call_result\ndata: ${JSON.stringify({
    id: toolUseId,
    result: { content: 'done', isError: false },
    duration_ms: 12,
  })}\n\n`;

const doneFrame = (id: number): string => `id: ${id}\nevent: done\ndata: {}\n\n`;

function deps(): OpenStreamDeps {
  return {
    updateSession: vi.fn(),
    abortMap: new Map(),
    lastSeenSeqMap: new Map(),
    lastSeenBusIdMap: new Map(),
  };
}

/** Let the stubbed fetch + ReadableStream reads settle without firing timers,
 * so we can observe the state of the pump strictly ON the arrival tick. */
async function flushMicrotasks(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

const attachOpts = {
  url: `/api/coder/sessions/${SESSION_ID}/attach`,
  method: 'GET',
  reattach: true,
} as const;

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
  it('yields by elapsed time even before reaching the event count limit', async () => {
    const frames = [busInfoFrame('budget-bus')];
    for (let i = 0; i < 12; i++) frames.push(workerLogFrame(i, `e${i}`));
    frames.push(doneFrame(12));
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)));
    let elapsed = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (elapsed += 4));
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const d = deps();
    const pending = openStream(SESSION_ID, attachOpts, d);
    await vi.runAllTimersAsync();
    await pending;
    expect(timer.mock.calls.filter((call) => call[1] === 0).length).toBeGreaterThan(1);
    expect(d.lastSeenSeqMap.get(SESSION_ID)).toBe(12);
    expect(peekWorkerLog(SESSION_ID).map((event) => event.message))
      .toEqual([...Array.from({ length: 12 }, (_, i) => `e${i}`), 'done']);
    now.mockRestore();
    timer.mockRestore();
  });

  it('defers a since=-1 replay burst off the arrival tick and drains it in order', async () => {
    const N = 120;
    const frames = [busInfoFrame('bus-a')];
    for (let i = 0; i < N; i++) frames.push(workerLogFrame(i, `e${i}`));
    frames.push(doneFrame(N));
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(frames)));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const d = deps();
    const p = openStream(SESSION_ID, attachOpts, d);
    await flushMicrotasks();
    // The whole burst is only ENQUEUED on the arrival tick — the cursor
    // advances per event at processing time, so an untouched map proves no
    // synchronous processing happened inside the SSE read loop.
    expect(d.lastSeenSeqMap.get(SESSION_ID)).toBeUndefined();

    await vi.runAllTimersAsync();
    await p;

    // Strict arrival order, nothing lost, terminal event included.
    const expected = [...Array.from({ length: N }, (_, i) => `e${i}`), 'done'];
    expect(peekWorkerLog(SESSION_ID).map((e) => e.message)).toEqual(expected);
    // Cursor caught up to the terminal frame once the drain finished.
    expect(d.lastSeenSeqMap.get(SESSION_ID)).toBe(N);
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
    const p1 = openStream(SESSION_ID, attachOpts, deps());
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
    const p2 = openStream(SESSION_ID, attachOpts, deps());
    await vi.runAllTimersAsync();
    await p2;

    expect(peekWorkerLog(SESSION_ID).map((e) => e.message)).toEqual([
      'r1-0', 'r1-1', 'r1-2', 'done', 'r2-new', 'done',
    ]);
  });

  it('seeds cursor reattach with blocks already covered by Last-Event-ID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      toolResultFrame(6, 'read-1'),
      doneFrame(7),
    ])));
    const d = deps();
    const p = openStream(SESSION_ID, {
      ...attachOpts,
      lastEventId: 5,
      lastEventBusId: 'bus-a',
      initialBlocks: [{
        type: 'tool',
        call: { id: 'read-1', name: 'read_file', status: 'running' },
      }],
    }, d);

    await vi.runAllTimersAsync();
    await p;

    const turnPatches = vi.mocked(d.updateSession).mock.calls
      .map(([, patch]) => patch)
      .filter((patch) => typeof patch !== 'function' && patch.currentTurn)
      .map((patch) => typeof patch === 'function' ? null : patch.currentTurn);
    const finalTurn = turnPatches[turnPatches.length - 1];
    expect(finalTurn?.blocks).toHaveLength(1);
    expect(finalTurn?.blocks[0]).toMatchObject({
      type: 'tool',
      call: { id: 'read-1', status: 'done', result: { content: 'done' } },
    });
  });

  it('discards the pending queue when the stream is aborted before the drain runs', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const frames = [busInfoFrame('bus-a')];
        for (let i = 0; i < 10; i++) frames.push(workerLogFrame(i, `e${i}`));
        controller.enqueue(enc.encode(frames.join('')));
        // Stream intentionally left open — the run is still live.
      },
      cancel: cancelled,
    });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })));

    const d = deps();
    const p = openStream(SESSION_ID, attachOpts, d);
    await flushMicrotasks(); // burst enqueued; drain still parked on its first yield
    d.abortMap.get(SESSION_ID)!.abort(); // unmount / superseding openStream
    await vi.runAllTimersAsync();

    // Queue dropped wholesale: nothing processed, logged or cursor-advanced.
    expect(peekWorkerLog(SESSION_ID)).toHaveLength(0);
    expect(d.lastSeenSeqMap.size).toBe(0);

    await p;
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
