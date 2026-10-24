import { expect, it } from 'vitest';
import { NativeTreeScheduler } from '../workers/native-tree-scheduler.js';

it('overlaps adjacent readers and gives a queued writer a barrier before later readers', async () => {
  const scheduler = new NativeTreeScheduler(4), signal = new AbortController().signal, order: string[] = [];
  const a = await scheduler.acquire('read_only', signal), b = await scheduler.acquire('read_only', signal);
  const writer = scheduler.acquire('exclusive_write', signal).then(release => { order.push('write'); return release; });
  const reader = scheduler.acquire('read_only', signal).then(release => { order.push('read'); return release; });
  await Promise.resolve(); expect(order).toEqual([]);
  a(); await Promise.resolve(); expect(order).toEqual([]);
  b(); const releaseWriter = await writer; expect(order).toEqual(['write']);
  releaseWriter(); (await reader)(); expect(order).toEqual(['write', 'read']); scheduler.close();
});

it('removes cancelled queued children and rejects them before dispatch on owner close', async () => {
  const scheduler = new NativeTreeScheduler(1), ctrl = new AbortController();
  const release = await scheduler.acquire('read_only', ctrl.signal);
  const cancelled = new AbortController(), queued = scheduler.acquire('exclusive_write', cancelled.signal);
  const rejection = expect(queued).rejects.toThrow('cancel child'); cancelled.abort(new Error('cancel child')); await rejection;
  const next = scheduler.acquire('read_only', ctrl.signal), closed = expect(next).rejects.toThrow('owner closed');
  scheduler.close(); await closed; release(); release();
  await expect(scheduler.acquire('read_only', ctrl.signal)).rejects.toThrow('closed');
});

it('enforces the process scheduling capacity without granting a cancelled slot', async () => {
  const scheduler = new NativeTreeScheduler(1), signal = new AbortController().signal;
  const first = await scheduler.acquire('read_only', signal); let admitted = false;
  const next = scheduler.acquire('read_only', signal).then(release => { admitted = true; return release; });
  await Promise.resolve(); expect(admitted).toBe(false); first(); (await next)(); expect(admitted).toBe(true);
  expect(() => scheduler.acquire('read_only', AbortSignal.abort(new Error('cancelled')))).toThrow('cancelled'); scheduler.close();
});
