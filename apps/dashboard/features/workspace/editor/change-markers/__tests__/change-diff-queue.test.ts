import { describe, expect, it, vi } from 'vitest';
import { createChangeDiffQueue } from '../change-diff-queue.js';
import type { ChangeDiffReply, ChangeDiffRequest } from '../change-diff.worker.js';
import { computeChanges } from '../diff-to-changes.js';

function setup(initial = { baseline: 'old\n', current: 'new\n' }) {
  let snapshot = initial;
  const worker = {
    onmessage: null as ((event: { data: ChangeDiffReply }) => void) | null,
    onerror: null as (() => void) | null,
    postMessage: vi.fn<(request: ChangeDiffRequest) => void>(),
    terminate: vi.fn(),
  };
  const openWorker = vi.fn(() => worker as unknown as Worker);
  const read = vi.fn(() => snapshot);
  const publish = vi.fn();
  const queue = createChangeDiffQueue(read, publish, openWorker);
  const reply = (request: ChangeDiffRequest): void => {
    worker.onmessage?.({
      data: { revision: request.revision, changes: computeChanges(request.baseline, request.current) },
    });
  };
  return { worker, openWorker, read, publish, queue, reply, update: (next: typeof initial) => { snapshot = next; } };
}

describe('change marker diff queue', () => {
  it('does not create a worker for an unchanged buffer', () => {
    const { queue, openWorker, publish } = setup({ baseline: 'same\n', current: 'same\n' });
    queue.request();
    expect(openWorker).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledExactlyOnceWith([]);
  });

  it('keeps one request in flight and snapshots only the latest edit and baseline', () => {
    const { worker, queue, read, reply, publish, update } = setup();
    queue.request();
    const first = worker.postMessage.mock.calls[0][0];

    update({ baseline: 'old\n', current: 'intermediate\n' });
    queue.invalidate();
    queue.request();
    update({ baseline: 'committed\n', current: 'latest\n' });
    queue.invalidate();
    queue.request();
    expect(read).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    reply(first);
    expect(publish).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    const last = worker.postMessage.mock.calls[1][0];
    expect(last).toEqual({ revision: 2, baseline: 'committed\n', current: 'latest\n' });

    reply(last);
    expect(publish).toHaveBeenCalledExactlyOnceWith(computeChanges('committed\n', 'latest\n'));
  });

  it('invalidates the in-flight result immediately, before the debounce expires', () => {
    const { worker, queue, reply, publish } = setup();
    queue.request();
    queue.invalidate();
    reply(worker.postMessage.mock.calls[0][0]);
    expect(publish).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });

  it('terminates the worker and ignores late results after disposal', () => {
    const { worker, queue, reply, publish } = setup();
    queue.request();
    queue.dispose();
    reply(worker.postMessage.mock.calls[0][0]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('clears markers on a worker failure without calculating a synchronous fallback', () => {
    const { worker, queue, publish, openWorker } = setup();
    queue.request();
    worker.onerror?.();
    queue.invalidate();
    queue.request();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(openWorker).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith([]);
  });
});