/**
 * Unit tests for the refcounted shared-stream registry (hooks/shared-stream.ts).
 * Forces the Electron-iterator transport (mocked) so no DOM/EventSource is
 * needed; verifies one-connection-per-key fan-out, replay modes, and reopen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  interface Ctrl {
    push: (v: unknown) => void;
  }
  const controllers: Ctrl[] = [];
  let openCount = 0;
  let returnCount = 0;

  function makeStream() {
    openCount++;
    const buffer: unknown[] = [];
    let pending: ((r: IteratorResult<unknown>) => void) | null = null;
    let ended = false;
    controllers.push({
      push(v: unknown) {
        if (pending) {
          const res = pending;
          pending = null;
          res({ value: v, done: false });
        } else {
          buffer.push(v);
        }
      },
    });
    const iterator: AsyncIterator<unknown> = {
      next() {
        if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false });
        if (ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => {
          pending = res;
        });
      },
      return() {
        returnCount++;
        ended = true;
        if (pending) {
          const res = pending;
          pending = null;
          res({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  return {
    controllers,
    counts: () => ({ open: openCount, ret: returnCount }),
    reset() {
      controllers.length = 0;
      openCount = 0;
      returnCount = 0;
    },
    makeStream,
  };
});

vi.mock('../../lib/api-client.js', () => ({
  electronApi: () => ({ invoke: () => undefined, openStream: () => undefined }),
  apiStream: () => h.makeStream(),
}));

import { subscribeShared, type StreamDescriptor } from '../shared-stream.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function desc(replay: 'last' | 'none'): StreamDescriptor {
  return {
    key: 'idx:1',
    electronVerb: 'projects.indexStatusStream',
    electronArgs: { id: 1 },
    sseUrl: '/api/projects/1/index-status/stream',
    sseEvent: 'status',
    replay,
  };
}

describe('subscribeShared', () => {
  beforeEach(() => h.reset());

  it('shares ONE connection across identical keys and fans frames out', async () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = subscribeShared(desc('last'), (f) => a.push(f));
    const unsubB = subscribeShared(desc('last'), (f) => b.push(f));

    expect(h.counts().open).toBe(1); // two subscribers, one stream

    h.controllers[0].push('frame1');
    await flush();
    expect(a).toEqual(['frame1']);
    expect(b).toEqual(['frame1']);

    unsubA();
    expect(h.counts().ret).toBe(0); // still one subscriber → stays open
    unsubB();
    expect(h.counts().ret).toBe(1); // last out closes it
  });

  it("replays the last frame to a late joiner when replay='last'", async () => {
    const unsubA = subscribeShared(desc('last'), () => undefined);
    h.controllers[0].push('snapshot');
    await flush();

    const late: unknown[] = [];
    const unsubB = subscribeShared(desc('last'), (f) => late.push(f));
    expect(late).toEqual(['snapshot']); // immediate replay on subscribe

    unsubA();
    unsubB();
  });

  it("does NOT replay for replay='none' (delta streams)", async () => {
    const unsubA = subscribeShared(desc('none'), () => undefined);
    h.controllers[0].push('delta');
    await flush();

    const late: unknown[] = [];
    const unsubB = subscribeShared(desc('none'), (f) => late.push(f));
    expect(late).toEqual([]); // no replay of deltas

    unsubA();
    unsubB();
  });

  it('reopens a fresh connection after the refcount hits zero', () => {
    const unsub = subscribeShared(desc('last'), () => undefined);
    expect(h.counts().open).toBe(1);
    unsub();
    const unsub2 = subscribeShared(desc('last'), () => undefined);
    expect(h.counts().open).toBe(2);
    unsub2();
  });
});
