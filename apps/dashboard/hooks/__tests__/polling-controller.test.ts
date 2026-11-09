import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPolling } from '../polling-controller.js';

function documentFixture(hidden = false) {
  const events = new EventTarget();
  return {
    get visibilityState() { return hidden ? 'hidden' as const : 'visible' as const; },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setHidden(next: boolean) { hidden = next; events.dispatchEvent(new Event('visibilitychange')); },
  };
}
let dispose: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

describe('status polling lifecycle', () => {
  it('does no work when mounted hidden and refreshes on restoration', async () => {
    const doc = documentFixture(true), callback = vi.fn();
    dispose = startPolling(callback, 100, true, doc);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    doc.setHidden(false);
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(2);
    doc.setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a slow request instead of queuing overlapping refreshes', async () => {
    let complete!: () => void;
    const callback = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const doc = documentFixture();
    dispose = startPolling(callback, 100, true, doc);
    await vi.advanceTimersByTimeAsync(10_000);
    doc.setHidden(true); doc.setHidden(false);
    expect(callback).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(99);
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(2);
    dispose(); complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors delayed polling and cannot restart after disposal', async () => {
    const callback = vi.fn(), doc = documentFixture();
    dispose = startPolling(callback, 100, false, doc);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(1);
    dispose(); doc.setHidden(true); doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers after a rejected refresh', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const callback = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    dispose = startPolling(callback, 100, true, documentFixture());
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
