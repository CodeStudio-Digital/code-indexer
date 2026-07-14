import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adaptCompletionText,
  ClientCompletionFlightCoordinator,
  type ClientCompletionSnapshot,
} from '../completionFlightCoordinator.js';

const base: ClientCompletionSnapshot = {
  uri: 'file:///p1/a.ts', prefix: 'ret', suffix: '', line: 2, col: 4,
  documentVersion: 1, trigger: 'automatic',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ClientCompletionFlightCoordinator', () => {
  it('hands a compatible flight from a cancelled Monaco invocation to the next version', async () => {
    const d = deferred<string>();
    const start = vi.fn(() => d.promise);
    const cancel = vi.fn();
    const coordinator = new ClientCompletionFlightCoordinator<string>();
    const first = coordinator.acquire({ key: '1:a.ts', snapshot: base, start, cancel, cancelDelayMs: 500, createId: () => 'req-1' });
    first.release(true);
    const second = coordinator.acquire({
      key: '1:a.ts', snapshot: { ...base, prefix: 'retu', col: 5, documentVersion: 2 },
      start, cancel, cancelDelayMs: 500,
    });
    d.resolve('return value;');
    expect(await second.promise).toBe('return value;');
    expect(second.typedThrough).toBe('u');
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('aborts the exact old request for a divergent edit', () => {
    const coordinator = new ClientCompletionFlightCoordinator<string>();
    const cancel = vi.fn();
    const never = () => new Promise<string>(() => undefined);
    coordinator.acquire({ key: '1:a.ts', snapshot: base, start: never, cancel, cancelDelayMs: 500, createId: () => 'old' });
    coordinator.acquire({ key: '1:a.ts', snapshot: { ...base, prefix: 'throw', col: 6, documentVersion: 2 }, start: never, cancel, cancelDelayMs: 500, createId: () => 'new' });
    expect(cancel).toHaveBeenCalledWith('old');
  });

  it('never reuses a result across files or explicit/automatic trigger modes', () => {
    const coordinator = new ClientCompletionFlightCoordinator<string>();
    const cancel = vi.fn();
    const never = vi.fn(() => new Promise<string>(() => undefined));
    coordinator.acquire({ key: 'shared', snapshot: base, start: never, cancel, cancelDelayMs: 500, createId: () => 'one' });
    coordinator.acquire({
      key: 'shared', snapshot: { ...base, uri: 'file:///p1/b.ts', trigger: 'explicit' },
      start: never, cancel, cancelDelayMs: 500, createId: () => 'two',
    });
    expect(cancel).toHaveBeenCalledWith('one');
    expect(never).toHaveBeenCalledTimes(2);
  });

  it('cancels only after the last waiter stays absent for the grace window', async () => {
    const coordinator = new ClientCompletionFlightCoordinator<string>();
    const cancel = vi.fn();
    const lease = coordinator.acquire({
      key: '1:a.ts', snapshot: base, start: () => new Promise(() => undefined),
      cancel, cancelDelayMs: 400, createId: () => 'req-1',
    });
    lease.release(true);
    await vi.advanceTimersByTimeAsync(399);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancel).toHaveBeenCalledWith('req-1');
  });

  it('notifies once when a result lands without a current waiter and caches it briefly', async () => {
    const d = deferred<string>();
    const orphaned = vi.fn();
    const start = vi.fn(() => d.promise);
    const coordinator = new ClientCompletionFlightCoordinator<string>();
    const lease = coordinator.acquire({
      key: '1:a.ts', snapshot: base, start, cancel: vi.fn(), cancelDelayMs: 500,
      createId: () => 'req-1', onOrphaned: orphaned,
    });
    lease.release(true);
    d.resolve('return;');
    await Promise.resolve();
    expect(orphaned).toHaveBeenCalledTimes(1);
    const cached = coordinator.acquire({
      key: '1:a.ts', snapshot: base, start, cancel: vi.fn(), cancelDelayMs: 500,
    });
    expect(await cached.promise).toBe('return;');
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('adaptCompletionText', () => {
  it('removes characters typed through the pending completion', () => {
    expect(adaptCompletionText('return value;', 'ret')).toEqual({ text: 'urn value;' });
  });

  it('distinguishes divergence from a fully consumed completion', () => {
    expect(adaptCompletionText('return', 'xyz')).toEqual({ reason: 'prefix_diverged' });
    expect(adaptCompletionText('return', 'return')).toEqual({ reason: 'empty_after_trim' });
  });
});
