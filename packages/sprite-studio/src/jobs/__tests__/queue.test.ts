import { describe, expect, it } from 'vitest';
import { SpriteJobQueue } from '../queue.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Controlled {
  started: number[];
  finish: (jobId: number) => void;
  make: (jobId: number) => (signal: AbortSignal) => Promise<void>;
}

/** Jobs that record their start order and finish only when told to. */
function controlled(): Controlled {
  const started: number[] = [];
  const resolvers = new Map<number, () => void>();
  return {
    started,
    finish: (jobId) => resolvers.get(jobId)?.(),
    make: (jobId) => () =>
      new Promise<void>((resolve) => {
        started.push(jobId);
        resolvers.set(jobId, resolve);
      }),
  };
}

describe('SpriteJobQueue', () => {
  it('runs jobs of one project strictly FIFO, one at a time', async () => {
    const q = new SpriteJobQueue(2);
    const c = controlled();
    q.enqueue(1, 11, c.make(11));
    q.enqueue(1, 12, c.make(12));
    q.enqueue(1, 13, c.make(13));
    await tick();
    expect(c.started).toEqual([11]); // same project: no parallelism
    c.finish(11);
    await tick();
    expect(c.started).toEqual([11, 12]);
    c.finish(12);
    await tick();
    expect(c.started).toEqual([11, 12, 13]);
    c.finish(13);
    await tick();
    expect(q.running).toBe(0);
  });

  it('caps global concurrency at 2 across projects', async () => {
    const q = new SpriteJobQueue(2);
    const c = controlled();
    q.enqueue(1, 21, c.make(21));
    q.enqueue(2, 22, c.make(22));
    q.enqueue(3, 23, c.make(23));
    await tick();
    expect(c.started).toEqual([21, 22]); // third project waits for a slot
    expect(q.running).toBe(2);
    c.finish(21);
    await tick();
    expect(c.started).toEqual([21, 22, 23]);
    c.finish(22);
    c.finish(23);
    await tick();
  });

  it('cancel removes a queued job before it ever starts', async () => {
    const q = new SpriteJobQueue(2);
    const c = controlled();
    q.enqueue(1, 31, c.make(31));
    q.enqueue(1, 32, c.make(32));
    expect(q.isActive(32)).toBe(true);
    expect(q.cancel(32)).toBe(true);
    expect(q.isActive(32)).toBe(false);
    c.finish(31);
    await tick();
    expect(c.started).toEqual([31]); // 32 never ran
    expect(q.cancel(999)).toBe(false); // unknown job
  });

  it('cancel aborts the signal of a running job', async () => {
    const q = new SpriteJobQueue(2);
    let observed: AbortSignal | undefined;
    q.enqueue(1, 41, (signal) => {
      observed = signal;
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    await tick();
    expect(observed?.aborted).toBe(false);
    expect(q.cancel(41)).toBe(true);
    expect(observed?.aborted).toBe(true);
    await tick();
    expect(q.isActive(41)).toBe(false); // slot released after abort resolves
  });

  it('rejects double-enqueue of the same job id', () => {
    const q = new SpriteJobQueue(2);
    const c = controlled();
    q.enqueue(1, 51, c.make(51));
    expect(() => q.enqueue(1, 51, c.make(51))).toThrow(/already/);
    c.finish(51);
  });
});
