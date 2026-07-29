import { describe, expect, it } from 'vitest';
import { SpriteJobQueue } from '../queue.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const id = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Controlled {
  started: string[];
  finish: (jobId: string) => void;
  make: (jobId: string) => (signal: AbortSignal) => Promise<void>;
}

/** Jobs that record their start order and finish only when told to. */
function controlled(): Controlled {
  const started: string[] = [];
  const resolvers = new Map<string, () => void>();
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
    q.enqueue(id(1), id(11), c.make(id(11)));
    q.enqueue(id(1), id(12), c.make(id(12)));
    q.enqueue(id(1), id(13), c.make(id(13)));
    await tick();
    expect(c.started).toEqual([id(11)]); // same project: no parallelism
    c.finish(id(11));
    await tick();
    expect(c.started).toEqual([id(11), id(12)]);
    c.finish(id(12));
    await tick();
    expect(c.started).toEqual([id(11), id(12), id(13)]);
    c.finish(id(13));
    await tick();
    expect(q.running).toBe(0);
  });

  it('caps global concurrency at 2 across projects', async () => {
    const q = new SpriteJobQueue(2);
    const c = controlled();
    q.enqueue(id(1), id(21), c.make(id(21)));
    q.enqueue(id(2), id(22), c.make(id(22)));
    q.enqueue(id(3), id(23), c.make(id(23)));
    await tick();
    expect(c.started).toEqual([id(21), id(22)]); // third project waits for a slot
    expect(q.running).toBe(2);
    c.finish(id(21));
    await tick();
    expect(c.started).toEqual([id(21), id(22), id(23)]);
    c.finish(id(22));
    c.finish(id(23));
    await tick();
  });

  it('cancel removes a queued job before it ever starts', async () => {
    const q = new SpriteJobQueue(2);
    const c = controlled();
    q.enqueue(id(1), id(31), c.make(id(31)));
    q.enqueue(id(1), id(32), c.make(id(32)));
    expect(q.isActive(id(32))).toBe(true);
    expect(q.cancel(id(32))).toBe(true);
    expect(q.isActive(id(32))).toBe(false);
    c.finish(id(31));
    await tick();
    expect(c.started).toEqual([id(31)]); // 32 never ran
    expect(q.cancel(id(999))).toBe(false); // unknown job
  });

  it('cancel aborts the signal of a running job', async () => {
    const q = new SpriteJobQueue(2);
    let observed: AbortSignal | undefined;
    q.enqueue(id(1), id(41), (signal) => {
      observed = signal;
      return new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    await tick();
    expect(observed?.aborted).toBe(false);
    expect(q.cancel(id(41))).toBe(true);
    expect(observed?.aborted).toBe(true);
    await tick();
    expect(q.isActive(id(41))).toBe(false); // slot released after abort resolves
  });

  it('rejects double-enqueue of the same job id', () => {
    const q = new SpriteJobQueue(2);
    const c = controlled();
    q.enqueue(id(1), id(51), c.make(id(51)));
    expect(() => q.enqueue(id(1), id(51), c.make(id(51)))).toThrow(/already/);
    c.finish(id(51));
  });
});
