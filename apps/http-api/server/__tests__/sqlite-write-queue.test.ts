import { describe, expect, it, vi } from 'vitest';
import {
  SqliteWriteQueue,
  SqliteWriteQueueFullError,
  isSqliteBusyError,
} from '../sqlite-write-queue.js';

function busy(): Error & { code: string } {
  return Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
}

describe('SqliteWriteQueue', () => {
  it('serializes writes and retries SQLITE_BUSY outside the synchronous attempt', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let attempts = 0;
    const queue = new SqliteWriteQueue({ retryBaseMs: 10, retryMaxMs: 10 });

    const first = queue.run(() => {
      attempts += 1;
      order.push(`first:${attempts}`);
      if (attempts === 1) throw busy();
      return 7;
    });
    const second = queue.run(() => {
      order.push('second');
      return 9;
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toBe(7);
    await expect(second).resolves.toBe(9);
    expect(order).toEqual(['first:1', 'first:2', 'second']);
    expect(queue.pendingWrites).toBe(0);
    vi.useRealTimers();
  });

  it('does not retry non-contention failures', async () => {
    const queue = new SqliteWriteQueue();
    const operation = vi.fn(() => {
      throw new Error('invalid row');
    });
    await expect(queue.run(operation)).rejects.toThrow('invalid row');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('bounds pending work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = new SqliteWriteQueue({ label: 'memory', maxPending: 1 });
    const active = queue.run(() => gate) as unknown as Promise<void>;
    await expect(queue.run(() => 2)).rejects.toBeInstanceOf(SqliteWriteQueueFullError);
    release();
    await active;
  });
});

describe('isSqliteBusyError', () => {
  it('recognizes SQLite codes and messages', () => {
    expect(isSqliteBusyError(busy())).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY_SNAPSHOT' })))
      .toBe(true);
    expect(isSqliteBusyError(new Error('database is busy'))).toBe(true);
    expect(isSqliteBusyError(new Error('network failed'))).toBe(false);
  });
});
