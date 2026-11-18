import { expect, it } from 'vitest';
import { DiagnosticQueue } from '../diagnostic-queue.js';

it('coalesces diagnostics, bounds memory, and drains accepted writes on close', async () => {
  const writes: number[] = [];
  const queue = new DiagnosticQueue(() => undefined, 2);
  expect(queue.enqueue('a', async () => { writes.push(1); })).toBe(true);
  expect(queue.enqueue('a', async () => { writes.push(2); })).toBe(true);
  expect(queue.enqueue('b', async () => { writes.push(3); })).toBe(true);
  expect(queue.enqueue('overflow', async () => { writes.push(4); })).toBe(false);
  await queue.close();
  expect(writes).toEqual([2, 3]);
  expect(queue.enqueue('closed', async () => undefined)).toBe(false);
});

it('never queues a second disk write ahead of incoming conversation work', async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queue = new DiagnosticQueue(() => undefined);
  queue.enqueue('slow', async () => { order.push('first'); await gate; });
  queue.enqueue('next', async () => { order.push('second'); });
  const flushed = queue.flush();
  order.push('conversation');
  expect(order).toEqual(['first','conversation']);
  release();
  await flushed;
  expect(order).toEqual(['first','conversation','second']);
});

it('a failed diagnostic does not discard subsequent accepted work', async () => {
  const errors: unknown[] = [];
  let persisted = false;
  const queue = new DiagnosticQueue(error => { errors.push(error); });
  queue.enqueue('bad', async () => { throw new Error('disk failure'); });
  queue.enqueue('good', async () => { persisted = true; });
  await queue.close();
  expect(errors).toHaveLength(1);
  expect(persisted).toBe(true);
});
