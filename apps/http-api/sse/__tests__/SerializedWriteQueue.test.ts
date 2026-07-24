import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SerializedWriteQueue,
  SlowConsumerError,
} from '../SerializedWriteQueue.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SerializedWriteQueue', () => {
  it('writes strictly in enqueue order', async () => {
    const releases: Array<() => void> = [];
    const writes: string[] = [];
    const queue = new SerializedWriteQueue<string>((value) => {
      writes.push(value);
      return new Promise<void>((resolve) => releases.push(resolve));
    });

    const first = queue.enqueue('a', 1);
    const second = queue.enqueue('b', 1);
    await vi.waitFor(() => expect(writes).toEqual(['a']));
    releases.shift()?.();
    await first;
    await vi.waitFor(() => expect(writes).toEqual(['a', 'b']));
    releases.shift()?.();
    await second;
    expect(queue.pendingWrites).toBe(0);
    expect(queue.pendingBytes).toBe(0);
  });

  it('keeps a heartbeat in the same FIFO as data and terminal frames', async () => {
    const releases: Array<() => void> = [];
    const writes: string[] = [];
    const queue = new SerializedWriteQueue<string>((value) => {
      writes.push(value);
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    const writer = (value: string) => queue.enqueue(value, value.length);

    const data = writer('data:token');
    const heartbeat = writer('ping');
    const terminal = writer('done');
    await vi.waitFor(() => expect(writes).toEqual(['data:token']));

    releases.shift()?.();
    await data;
    await vi.waitFor(() => expect(writes).toEqual(['data:token', 'ping']));
    releases.shift()?.();
    await heartbeat;
    await vi.waitFor(() => expect(writes).toEqual(['data:token', 'ping', 'done']));
    releases.shift()?.();
    await terminal;
  });

  it('stops a slow subscriber when the pending-write limit is exceeded', async () => {
    let release!: () => void;
    const writes: string[] = [];
    const onOverflow = vi.fn();
    const queue = new SerializedWriteQueue<string>((value) => {
      writes.push(value);
      return new Promise<void>((resolve) => { release = resolve; });
    }, {
      maxPendingWrites: 2,
      maxPendingBytes: 1_000,
      onOverflow,
    });

    const first = queue.enqueue('a', 1);
    await vi.waitFor(() => expect(writes).toEqual(['a']));
    const second = queue.enqueue('b', 1).catch((error) => error);
    await expect(queue.enqueue('c', 1)).rejects.toBeInstanceOf(SlowConsumerError);
    expect(queue.isStopped).toBe(true);
    expect(onOverflow).toHaveBeenCalledTimes(1);

    release();
    await first;
    await second;
    await queue.waitForIdle();
    // The already-active write may finish; queued frames are discarded so
    // the reconnect starts from the client's last actually-received seq.
    expect(writes).toEqual(['a']);
  });

  it('rejects one oversized item even when the queue is empty', async () => {
    const write = vi.fn(async () => undefined);
    const queue = new SerializedWriteQueue<string>(write, {
      maxPendingWrites: 10,
      maxPendingBytes: 10,
    });

    await expect(queue.enqueue('large', 20)).rejects.toBeInstanceOf(SlowConsumerError);
    expect(write).not.toHaveBeenCalled();
    expect(queue.pendingWrites).toBe(0);
    expect(queue.pendingBytes).toBe(0);
  });

  it('stops queued writes after a transport write error', async () => {
    const failure = new Error('socket closed');
    const onWriteError = vi.fn();
    const write = vi.fn(async () => { throw failure; });
    const queue = new SerializedWriteQueue<string>(write, { onWriteError });

    await expect(queue.enqueue('a', 1)).rejects.toBe(failure);
    await expect(queue.enqueue('b', 1)).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(1);
    expect(onWriteError).toHaveBeenCalledWith(failure);
  });

  it('bounds terminal drain when a transport callback never arrives', async () => {
    vi.useFakeTimers();
    const queue = new SerializedWriteQueue<string>(
      () => new Promise<void>(() => undefined),
    );
    void queue.enqueue('hung', 1).catch(() => undefined);
    await Promise.resolve();

    const result = queue.waitForIdle(25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBe(false);
    queue.stop();
  });

  it('drops and rejects queued payloads immediately when stop follows a hung write', async () => {
    let releaseActive!: () => void;
    const writes: string[] = [];
    const queue = new SerializedWriteQueue<string>((value) => {
      writes.push(value);
      return new Promise<void>((resolve) => { releaseActive = resolve; });
    });

    const active = queue.enqueue('active', 10);
    await vi.waitFor(() => expect(writes).toEqual(['active']));
    const queuedA = queue.enqueue('queued-a', 20);
    const queuedB = queue.enqueue('queued-b', 30);
    expect(queue.pendingWrites).toBe(3);
    expect(queue.pendingBytes).toBe(60);

    const stopped = new Error('connection closed');
    queue.stop(stopped);

    // Only the transport-owned active value remains referenced. Both queued
    // promises settle now even though that active write is still hung.
    expect(queue.pendingWrites).toBe(1);
    expect(queue.pendingBytes).toBe(10);
    await expect(queuedA).rejects.toBe(stopped);
    await expect(queuedB).rejects.toBe(stopped);

    releaseActive();
    await active;
    expect(queue.pendingWrites).toBe(0);
    expect(queue.pendingBytes).toBe(0);
  });
});
