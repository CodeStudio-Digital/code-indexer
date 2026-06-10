/**
 * Regression — the scaffold SSE pump must flush EVERY frame (especially the
 * terminal `done`) before it closes the stream. The previous fire-and-forget
 * `writeSSE` let `close()` race the trailing burst and drop `done`; the New
 * Project wizard then spun forever on a scaffold that had already finished.
 *
 * Pure unit test: the pump's only import is a type-only one, so this needs no
 * HTTP server, no DB, and no module mocks.
 */
import { describe, it, expect } from 'vitest';
import { pumpScaffoldSSE, type ScaffoldSseStream } from '../scaffold-sse-pump.js';
import type { ScaffoldStreamEvent } from '@mcp/api-bus';

const ev = (event: ScaffoldStreamEvent['event'], data: unknown = {}) =>
  ({ event, data }) as ScaffoldStreamEvent;

/** A stream whose writes take a couple of ticks, so we can prove `close()`
 *  waited for them rather than racing. */
function recordingStream() {
  const order: string[] = [];
  let inflight = 0;
  let closed = false;
  let closedWithInflight = -1;
  const stream: ScaffoldSseStream = {
    async writeSSE(m) {
      inflight++;
      await Promise.resolve();
      await Promise.resolve();
      order.push(m.event ?? 'message');
      inflight--;
    },
    async close() {
      closedWithInflight = inflight;
      closed = true;
    },
  };
  return {
    stream,
    get order() { return order; },
    get closed() { return closed; },
    get closedWithInflight() { return closedWithInflight; },
  };
}

describe('pumpScaffoldSSE — flush before close', () => {
  it('writes start→phase→done in order and closes only after all writes drain', async () => {
    const rec = recordingStream();
    await pumpScaffoldSSE(rec.stream, async (emit) => {
      // Emit the terminal burst synchronously — the exact shape that raced.
      emit(ev('start'));
      emit(ev('phase'));
      emit(ev('done', { project: { id: 1 } }));
    });
    expect(rec.order).toEqual(['start', 'phase', 'done']);
    expect(rec.closed).toBe(true);
    expect(rec.closedWithInflight).toBe(0); // nothing still in flight at close
  });

  it('emits an error frame when the runner throws, still before close', async () => {
    const rec = recordingStream();
    await pumpScaffoldSSE(rec.stream, async () => {
      throw new Error('boom');
    });
    expect(rec.order).toEqual(['error']);
    expect(rec.closed).toBe(true);
    expect(rec.closedWithInflight).toBe(0);
  });

  it('a failing write does not break the chain or prevent close', async () => {
    const order: string[] = [];
    let closed = false;
    const stream: ScaffoldSseStream = {
      async writeSSE(m) {
        if (m.event === 'phase') throw new Error('client gone');
        order.push(m.event ?? 'message');
      },
      async close() {
        closed = true;
      },
    };
    await pumpScaffoldSSE(stream, async (emit) => {
      emit(ev('start'));
      emit(ev('phase')); // this write rejects
      emit(ev('done', { project: { id: 1 } }));
    });
    expect(order).toEqual(['start', 'done']); // chain survived the failed write
    expect(closed).toBe(true);
  });
});
