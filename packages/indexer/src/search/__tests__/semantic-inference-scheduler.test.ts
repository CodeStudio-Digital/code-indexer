import { describe, expect, it, vi } from 'vitest';
import { SemanticInferenceScheduler } from '../semantic-inference-scheduler.js';

describe('SemanticInferenceScheduler', () => {
  it('budgets background batches while letting a new query bypass the cooldown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'performance'] });
    const scheduler = new SemanticInferenceScheduler(128, 0.5);
    try {
      const order: string[] = [];
      const first = scheduler.enqueue(0, async () => {
        await new Promise(resolve => setTimeout(resolve, 100));
        order.push('first');
      });
      const second = scheduler.enqueue(0, async () => { order.push('second'); });
      await vi.advanceTimersByTimeAsync(110);
      await first;
      expect(order).toEqual(['first']);
      const query = scheduler.enqueue(100, async () => { order.push('query'); });
      await vi.advanceTimersByTimeAsync(1);
      await query;
      expect(order).toEqual(['first', 'query']);
      await vi.advanceTimersByTimeAsync(89);
      await second;
      expect(order).toEqual(['first', 'query', 'second']);
    } finally { scheduler.close(); vi.useRealTimers(); }
  });

  it('cancels queued background work during a cooldown without starting it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'performance'] });
    const scheduler = new SemanticInferenceScheduler(128, 0.5);
    try {
      const first = scheduler.enqueue(0, () => new Promise(resolve => setTimeout(resolve, 100)));
      const run = vi.fn();
      const second = scheduler.enqueue(0, run);
      const stopped = expect(second).rejects.toThrow('scheduler stopped');
      await vi.advanceTimersByTimeAsync(110);
      await first;
      scheduler.close();
      await stopped;
      expect(run).not.toHaveBeenCalled();
      expect(scheduler.diagnostics().queued).toBe(0);
    } finally { scheduler.close(); vi.useRealTimers(); }
  });

  it('removes cancelled queries before native inference and bounds its waiting queue', async () => {
    const scheduler = new SemanticInferenceScheduler(1);
    let release!: () => void;
    const active = scheduler.enqueue(0, () => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    let ran = false;
    const cancelled = scheduler.enqueue(100, async () => { ran = true; }, { signal: controller.signal });
    await expect(scheduler.enqueue(0, async () => undefined)).rejects.toThrow('queue is full');
    controller.abort(new Error('closed search'));
    await expect(cancelled).rejects.toThrow('closed search');
    expect(scheduler.diagnostics().queued).toBe(0);
    release();
    await active;
    expect(ran).toBe(false);
  });
  it('lets an interactive query take the next slot ahead of queued backfill', async () => {
    const scheduler = new SemanticInferenceScheduler();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = scheduler.enqueue(0, async () => {
      order.push('active-build');
      await gate;
      return 1;
    });
    const queuedBuild = scheduler.enqueue(0, async () => {
      order.push('queued-build');
      return 2;
    });
    const query = scheduler.enqueue(100, async () => {
      order.push('query');
      return 3;
    });
    release();
    await Promise.all([active, queuedBuild, query]);
    expect(order).toEqual(['active-build', 'query', 'queued-build']);
  });

  it('keeps only the latest queued inference for one interactive surface', async () => {
    const scheduler = new SemanticInferenceScheduler();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = scheduler.enqueue(100, async () => {
      order.push('active');
      await gate;
      return 'active';
    }, { supersessionKey: 'search-everywhere:p1' });
    const obsolete = scheduler.enqueue(100, async () => {
      order.push('obsolete');
      return 'obsolete';
    }, { supersessionKey: 'search-everywhere:p1' });
    const latest = scheduler.enqueue(100, async () => {
      order.push('latest');
      return 'latest';
    }, { supersessionKey: 'search-everywhere:p1' });

    await expect(obsolete).rejects.toMatchObject({ code: 'SEMANTIC_INFERENCE_SUPERSEDED' });
    release();
    await expect(Promise.all([active, latest])).resolves.toEqual(['active', 'latest']);
    expect(order).toEqual(['active', 'latest']);
  });
});
