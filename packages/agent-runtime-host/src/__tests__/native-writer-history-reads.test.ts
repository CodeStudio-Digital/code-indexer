import { expect, it, vi } from 'vitest';
import { NativeWriterHistoryReads } from '../native/NativeWriterHistoryReads.js';
import type { EngineEventRecoveryStorePort } from '../native/NativeEngineEventRecovery.js';

it('serializes readers while allowing their independent source commits to progress', async () => {
  const reads = new NativeWriterHistoryReads();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const source = {} as EngineEventRecoveryStorePort;
  const first = reads.read(() => source, async () => { order.push('first'); await waiting; return 1; });
  const second = reads.read(() => source, async () => { order.push('second'); return 2; });
  await Promise.resolve();
  expect(order).toEqual(['first']);
  release();
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  expect(order).toEqual(['first', 'second']);
  await reads.close();
  const afterClose = vi.fn();
  expect(await reads.read(() => source, afterClose)).toBeUndefined();
  expect(afterClose).not.toHaveBeenCalled();
});

it('cancels a read at close and preserves integrity errors while the owner remains live', async () => {
  const reads = new NativeWriterHistoryReads();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const source = { list: async () => { entered(); await wait; return { records: [], nextGlobalSequence: 0n, complete: true }; },
    read: vi.fn() } as EngineEventRecoveryStorePort;
  await expect(reads.read(() => source, async () => { throw new Error('integrity failure'); })).rejects.toThrow('integrity failure');
  const projection = vi.fn();
  const pending = reads.read(() => source, async store => { const page = await store.list(0n, 1); projection(page); return page; });
  await started;
  const closed = reads.close();
  release();
  expect(await pending).toBeUndefined();
  await closed;
  expect(projection).not.toHaveBeenCalled();
});
