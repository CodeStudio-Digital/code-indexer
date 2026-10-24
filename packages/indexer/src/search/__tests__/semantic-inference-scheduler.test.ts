import { describe, expect, it } from 'vitest';
import { SemanticInferenceScheduler } from '../semantic-inference-scheduler.js';

describe('SemanticInferenceScheduler', () => {
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
