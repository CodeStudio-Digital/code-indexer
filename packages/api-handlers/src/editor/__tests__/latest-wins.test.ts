import { describe, expect, it, vi } from 'vitest';
import { LatestWinsCoordinator } from '../completion/latest-wins.js';

describe('LatestWinsCoordinator', () => {
  it('coalesces a compatible prefix advance and publishes only the latest waiter', async () => {
    const c = new LatestWinsCoordinator<string>();
    let release!: (value: string) => void;
    const execute = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const a = c.run('f', { clientRequestId: 'a', documentVersion: 1, prefix: 'ret', suffix: '' }, execute);
    const b = c.run('f', { clientRequestId: 'b', documentVersion: 2, prefix: 'return', suffix: '' }, execute);
    expect(c.cancel('a')).toBe(false); // cancellation ownership moved to b
    release('return value;');
    expect(await a).toMatchObject({ superseded: true, coalesced: false });
    expect(await b).toMatchObject({ superseded: false, coalesced: true, typedThrough: 'urn' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('aborts incompatible edits and supports exact cancellation', async () => {
    const c = new LatestWinsCoordinator<string>();
    const signals: AbortSignal[] = [];
    const never = (signal: AbortSignal) => { signals.push(signal); return new Promise<string>(() => undefined); };
    void c.run('f', { clientRequestId: 'a', documentVersion: 1, prefix: 'one', suffix: '' }, never);
    void c.run('f', { clientRequestId: 'b', documentVersion: 2, prefix: 'two', suffix: '' }, never);
    expect(signals[0]!.aborted).toBe(true);
    expect(c.cancel('b')).toBe(true);
    expect(signals[1]!.aborted).toBe(true);
    expect(c.cancel('missing')).toBe(false);
  });
});
