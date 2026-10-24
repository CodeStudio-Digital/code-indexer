import { expect, it, vi } from 'vitest';
import { readCursorWindow } from '../bounded-cursor.js';

function cursor(total = 10000) {
  let n = 0;
  const next = vi.fn(async () => ++n <= total ? { done: false as const, value: n } : { done: true as const, value: undefined });
  const close = vi.fn(async () => undefined);
  return { next, close, [Symbol.asyncIterator]: () => ({ next }) };
}
it('pulls only a page plus one row and confirms cursor cleanup', async () => {
  const source = cursor();
  expect(await readCursorWindow(source, 2, {})).toEqual({ rows: [1, 2], rowCount: 3, truncated: true });
  expect(source.next).toHaveBeenCalledTimes(3); expect(source.close).toHaveBeenCalledTimes(1);
});
it('drains a mutating aggregation while retaining bounded output', async () => {
  const source = cursor(10);
  expect(await readCursorWindow(source, 2, {}, true)).toEqual({ rows: [1, 2], rowCount: 10, truncated: true });
  expect(source.next).toHaveBeenCalledTimes(11); expect(source.close).toHaveBeenCalledTimes(1);
});
it('closes a blocked cursor on cancellation without requesting another batch', async () => {
  const source = cursor(), controller = new AbortController(); let release!: () => void;
  source.next.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ done: false, value: 1 }); }));
  source.close.mockImplementationOnce(async () => { release(); });
  const pending = readCursorWindow(source, 2, { signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow('cancelled');
  await vi.waitFor(() => expect(release).toBeTypeOf('function')); controller.abort(new Error('cancelled'));
  await rejected; expect(source.next).toHaveBeenCalledTimes(1); expect(source.close).toHaveBeenCalledTimes(1);
});
it('rechecks authority before each cursor batch and retains unconfirmed cleanup failure', async () => {
  const source = cursor(); let checks = 0;
  await expect(readCursorWindow(source, 2, { beforeDispatch: () => { if (++checks === 2) throw new Error('revoked'); } }))
    .rejects.toThrow('revoked');
  expect(source.next).toHaveBeenCalledTimes(1); expect(source.close).toHaveBeenCalledTimes(1);
  const failed = cursor(); failed.close.mockRejectedValueOnce(new Error('cursor close failed'));
  await expect(readCursorWindow(failed, 2, {})).rejects.toThrow('cursor close failed');
});
