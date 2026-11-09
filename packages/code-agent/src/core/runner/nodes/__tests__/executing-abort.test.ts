import { describe, expect, it } from 'vitest';
import { withAbort, withAbortAndTimeout } from '../executing-abort.js';
import { consumeStream } from '../executing-stream.js';

describe('cancellation observes the already started operation', () => {
  it('drains a late rejection after entering with an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    for (const call of [withAbort, (operation: Promise<unknown>, signal: AbortSignal) => withAbortAndTimeout(operation, { signal, ms: 1000 })]) {
      let reject!: (error: Error) => void;
      const operation = new Promise((_, failed) => { reject = failed; });
      await expect(call(operation, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
      reject(new Error('late operation rejection'));
      await new Promise(resolve => setImmediate(resolve));
    }
  });
  it('observes next() rejection when dispatch itself aborts the stream', async () => {
    const controller = new AbortController();
    const stream = { [Symbol.asyncIterator]: () => ({ next() {
      controller.abort();
      return Promise.reject(new Error('transport cancelled'));
    } }) };
    await expect(consumeStream({ stream, signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    await new Promise(resolve => setImmediate(resolve));
  });
});
