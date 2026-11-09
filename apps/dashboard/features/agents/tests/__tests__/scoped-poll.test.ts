import { afterEach, expect, it, vi } from 'vitest';
import { startScopedPoll } from '../shared/scoped-poll.js';

function surface() {
  const callbacks = new Set<() => void>();
  return { visibilityState: 'visible', addEventListener: (_event: string, listener: () => void) => callbacks.add(listener),
    removeEventListener: (_event: string, listener: () => void) => callbacks.delete(listener),
    emit() { for (const callback of callbacks) callback(); } } as unknown as Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> & { emit(): void };
}
afterEach(() => vi.useRealTimers());

it('continues polling after idle and observes a run started later', async () => {
  vi.useFakeTimers(); const visibility = surface();
  const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'new-run', status: 'running' });
  const publish = vi.fn();
  const poll = startScopedPoll(read, publish, () => 8000, visibility);
  await vi.advanceTimersByTimeAsync(0); expect(publish).toHaveBeenLastCalledWith(null, null);
  await vi.advanceTimersByTimeAsync(8000); expect(publish).toHaveBeenLastCalledWith({ id: 'new-run', status: 'running' }, null);
  poll.dispose(); expect(vi.getTimerCount()).toBe(0);
});

it('aborts on scope disposal and rejects stale responses even when fetch ignores abort', async () => {
  vi.useFakeTimers(); let resolve!: (value: string) => void; let signal!: AbortSignal;
  const publish = vi.fn();
  const first = startScopedPoll((s) => { signal = s; return new Promise<string>((done) => { resolve = done; }); }, publish, () => 1000, surface());
  first.dispose(); expect(signal.aborted).toBe(true);
  const second = startScopedPoll(async () => 'session-two', publish, () => 1000, surface());
  await vi.advanceTimersByTimeAsync(0); resolve('session-one'); await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenCalledExactlyOnceWith('session-two', null); second.dispose();
});

it('does not overlap slow reads or poll a hidden surface and refreshes on reveal', async () => {
  vi.useFakeTimers(); const visibility = surface(); let resolve!: (value: null) => void;
  const read = vi.fn(() => new Promise<null>((done) => { resolve = done; }));
  const poll = startScopedPoll(read, vi.fn(), () => 1000, visibility);
  await poll.refresh(); await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(1);
  Object.defineProperty(visibility, 'visibilityState', { value: 'hidden', writable: true }); visibility.emit();
  resolve(null); await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(1);
  Object.defineProperty(visibility, 'visibilityState', { value: 'visible', writable: true }); visibility.emit();
  expect(read).toHaveBeenCalledTimes(2); poll.dispose();
});
