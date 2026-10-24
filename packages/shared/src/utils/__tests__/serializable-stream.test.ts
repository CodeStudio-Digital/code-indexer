import { describe, expect, it, vi } from 'vitest';
import {
  fromSerializableAsyncIterator,
  toSerializableAsyncIterator,
} from '../serializable-stream.js';

describe('serializable stream bridge', () => {
  it('keeps the preload-facing value free of symbol-keyed properties', async () => {
    async function* source() {
      yield 'first';
      yield 'second';
    }

    const bridged = toSerializableAsyncIterator(source());

    expect(Reflect.ownKeys(bridged)).toEqual(['next', 'return']);
    await expect(bridged.next()).resolves.toEqual({ value: 'first', done: false });
  });

  it('restores a local AsyncIterable and forwards cleanup', async () => {
    const next = vi.fn()
      .mockResolvedValueOnce({ value: ['task-1'], done: false })
      .mockResolvedValueOnce({ value: undefined, done: true });
    const close = vi.fn().mockResolvedValue({ value: undefined, done: true });
    const iterable = fromSerializableAsyncIterator({ next, return: close });
    const iterator = iterable[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ value: ['task-1'], done: false });
    await expect(iterator.return?.()).resolves.toEqual({ value: undefined, done: true });
    expect(close).toHaveBeenCalledOnce();
  });
});
