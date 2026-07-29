/**
 * Regression — a replay must not re-apply accumulative deltas.
 *
 * `text` / `thinking` handlers GROW the block buffer by concatenation
 * (`prior.text += t`). A cursorless attach replays the whole live tail since
 * the last `message_complete`, and the server also full-replays whenever it
 * cannot honour our cursor — so without a high-water mark the same answer and
 * the same reasoning were appended a second time inside one card.
 *
 * Everything else stays exempt: tool/lifecycle events are keyed by identity and
 * a replay must remain able to REBUILD that structure after a bus reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openStream, type OpenStreamDeps } from '../openStream.js';
import { __resetWorkerLogForTests } from '../worker-log-store.js';

const applied = vi.hoisted(() => ({ deltas: [] as string[], tools: [] as string[] }));

vi.mock('../handlers.js', () => ({
  createEventHandlers: () => ({
    text: (d: Record<string, unknown>) => { applied.deltas.push(`text:${String(d.text ?? '')}`); },
    thinking: (d: Record<string, unknown>) => { applied.deltas.push(`thinking:${String(d.text ?? '')}`); },
    tool_call_start: (d: Record<string, unknown>) => { applied.tools.push(String(d.id ?? '')); },
    stream_rollback: (d: Record<string, unknown>) => { applied.deltas.push(`rollback:${String(d.thinkingChars ?? 0)}`); },
  }),
}));

const enc = new TextEncoder();
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const ATTACH_URL = `/api/coder/sessions/${SESSION_ID}/attach`;

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
    lastSeenBusIdMap: new Map(),
  };
}

/** The live tail a reattach replays, then one genuinely new delta. */
const REPLAYED_TAIL = [
  'id: 0\nevent: thinking\ndata: {"text":"thinkA"}\n\n',
  'id: 1\nevent: tool_call_start\ndata: {"id":"tool-1","name":"read_file"}\n\n',
  'id: 2\nevent: text\ndata: {"text":"answer"}\n\n',
  'id: 3\nevent: text\ndata: {"text":" continues"}\n\n',
  'id: 4\nevent: done\ndata: {}\n\n',
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  __resetWorkerLogForTests();
  applied.deltas = [];
  applied.tools = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('openStream replay dedup', () => {
  it('skips accumulative deltas at or below the paired cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      'event: bus_info\ndata: {"bus_id":"bus-a"}\n\n',
      ...REPLAYED_TAIL,
    ])));
    const d = deps();
    const p = openStream(
      SESSION_ID,
      {
        url: ATTACH_URL,
        method: 'GET',
        reattach: true,
        lastEventId: 2,
        lastEventBusId: 'bus-a',
        initialBlocks: [{ type: 'thinking', text: 'thinkA', id: 'th-0' }],
      },
      d,
    );
    await vi.advanceTimersByTimeAsync(10);
    await p;

    // seq 0 and 2 were already folded into `initialBlocks`; only seq 3 is new.
    expect(applied.deltas).toEqual(['text: continues']);
    // Identity-keyed events stay exempt — a replay must still rebuild them.
    expect(applied.tools).toEqual(['tool-1']);
  });

  it('applies the whole replay when the bus changed under us', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      // The server could not honour the cursor and full-replayed a new bus.
      'event: bus_info\ndata: {"bus_id":"bus-b"}\n\n',
      ...REPLAYED_TAIL,
    ])));
    const d = deps();
    const p = openStream(
      SESSION_ID,
      { url: ATTACH_URL, method: 'GET', reattach: true, lastEventId: 2, lastEventBusId: 'bus-a' },
      d,
    );
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(applied.deltas).toEqual(['thinking:thinkA', 'text:answer', 'text: continues']);
  });

  it('skips a replayed rollback so it cannot retract content twice', async () => {
    // `stream_rollback` RETRACTS by character count — re-applying it would eat
    // content the first application already removed. It has to be skipped
    // exactly when the deltas it cancels are skipped.
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      'event: bus_info\ndata: {"bus_id":"bus-a"}\n\n',
      'id: 0\nevent: thinking\ndata: {"text":"discarded attempt"}\n\n',
      'id: 1\nevent: stream_rollback\ndata: {"textChars":0,"thinkingChars":17}\n\n',
      'id: 2\nevent: thinking\ndata: {"text":"retry reasoning"}\n\n',
      'id: 3\nevent: done\ndata: {}\n\n',
    ])));
    const d = deps();
    const p = openStream(
      SESSION_ID,
      {
        url: ATTACH_URL,
        method: 'GET',
        reattach: true,
        lastEventId: 2,
        lastEventBusId: 'bus-a',
        initialBlocks: [{ type: 'thinking', text: 'retry reasoning', id: 'th-0' }],
      },
      d,
    );
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(applied.deltas).toEqual([]);
  });

  it('applies everything on a fresh stream with no cursor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      'event: bus_info\ndata: {"bus_id":"bus-a"}\n\n',
      ...REPLAYED_TAIL,
    ])));
    const d = deps();
    const p = openStream(SESSION_ID, { url: ATTACH_URL, method: 'GET' }, d);
    await vi.advanceTimersByTimeAsync(10);
    await p;

    expect(applied.deltas).toEqual(['thinking:thinkA', 'text:answer', 'text: continues']);
  });
});
