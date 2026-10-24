import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundaryPreparation } from '../boundary-preparation.js';

afterEach(() => vi.useRealTimers());

describe('proactive preparation at turn boundaries', () => {
  it('returns after 300ms and consumes the late value only at the next matching boundary', async () => {
    vi.useFakeTimers();
    const preparation = new BoundaryPreparation<string>();
    let finish!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const first = preparation.take('task', load);
    await vi.advanceTimersByTimeAsync(300);
    expect(await first).toBeUndefined();
    finish('memory');
    await Promise.resolve();
    expect(await preparation.take('task', load)).toBe('memory');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('bounds pending lookups and discards results for a superseded task', async () => {
    vi.useFakeTimers();
    const preparation = new BoundaryPreparation<string>();
    let finish!: (value: string) => void;
    const first = preparation.take('old', () => new Promise<string>((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(300);
    await first;
    const load = vi.fn(async () => 'new-result');
    expect(await preparation.take('new', load)).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    finish('obsolete');
    await vi.advanceTimersByTimeAsync(0);
    expect(await preparation.take('new', load)).toBe('new-result');
  });

  it('cancels the wait promptly and contains late rejection', async () => {
    const ctrl = new AbortController();
    const preparation = new BoundaryPreparation<string>();
    let fail!: (error: Error) => void;
    const pending = preparation.take('task', () => new Promise<string>((_, reject) => { fail = reject; }), ctrl.signal);
    await Promise.resolve();
    ctrl.abort();
    expect(await pending).toBeUndefined();
    fail(new Error('late failure'));
    await Promise.resolve();
  });
});
