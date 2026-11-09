import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseDriver } from '../types.js';
const mocks = vi.hoisted(() => ({ createDriver: vi.fn() }));
vi.mock('../factory.js', () => ({ createDriver: mocks.createDriver }));
import { DbConnectionManager } from '../manager.js';

const managers: DbConnectionManager[] = [];
const manager = () => { const value = new DbConnectionManager(); managers.push(value); return value; };
const config = { engine: 'postgres' as const };
const driver = () => ({ close: vi.fn(async () => {}) }) as unknown as DatabaseDriver;
function deferred() {
  let resolve!: (value: DatabaseDriver) => void;
  const promise = new Promise<DatabaseDriver>(complete => { resolve = complete; });
  return { promise, resolve };
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map(value => value.closeAll()));
  vi.useRealTimers(); mocks.createDriver.mockReset();
});

describe('database pool lifecycle', () => {
  it('supersedes simultaneous configuration rotations without a circular wait', async () => {
    const mgr = manager(); mocks.createDriver.mockResolvedValue(driver());
    const results = await Promise.allSettled([
      mgr.acquire('tenant:old', config, { invalidatePrefix: 'tenant:' }),
      mgr.acquire('tenant:new', config, { invalidatePrefix: 'tenant:' }),
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(mgr.has('tenant:old')).toBe(false);
    expect(mgr.has('tenant:new')).toBe(true);
    expect(mocks.createDriver).toHaveBeenCalledOnce();
  });

  it('rejects excess pools before setup without evicting existing work', async () => {
    const mgr = new DbConnectionManager({ pools: 1, activePerPool: 1 }); managers.push(mgr);
    mocks.createDriver.mockResolvedValue(driver());
    await mgr.acquire('first', config);
    await expect(mgr.acquire('second', config)).rejects.toThrow('capacity');
    expect(mgr.has('first')).toBe(true);
    expect(mocks.createDriver).toHaveBeenCalledOnce();
  });
  it('shares one connection setup among concurrent callers of the same key', async () => {
    const db = driver(); mocks.createDriver.mockResolvedValue(db);
    const mgr = manager();
    const results = await Promise.all(Array.from({ length: 20 }, () => mgr.acquire('conn:1', config)));
    expect(mocks.createDriver).toHaveBeenCalledOnce();
    expect(results.every(value => value === results[0])).toBe(true);
  });

  it.each(['key', 'all'])('drains late setup after close %s and never resurrects its pool', async scope => {
    const opening = deferred(); mocks.createDriver.mockReturnValue(opening.promise);
    const mgr = manager(); const db = driver();
    const pending = mgr.acquire('conn:1', config);
    await Promise.resolve();
    const result = expect(pending).rejects.toThrow(/closed during connection setup/);
    const closing = scope === 'all' ? mgr.closeAll() : mgr.closeKey('conn:1');
    opening.resolve(db);
    await closing; await result;
    expect(mgr.has('conn:1')).toBe(false);
    expect(db.close).toHaveBeenCalledOnce();
  });

  it('allows independent keys to connect concurrently and a failed setup to retry', async () => {
    const a = deferred(); const b = deferred();
    mocks.createDriver.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const mgr = manager();
    const pa = mgr.acquire('conn:1', config); const pb = mgr.acquire('conn:2', config);
    await Promise.resolve();
    expect(mocks.createDriver).toHaveBeenCalledTimes(2);
    a.resolve(driver()); b.resolve(driver()); await Promise.all([pa, pb]);
    mocks.createDriver.mockRejectedValueOnce(new Error('connection refused')).mockResolvedValueOnce(driver());
    await expect(mgr.acquire('conn:3', config)).rejects.toThrow('connection refused');
    await expect(mgr.acquire('conn:3', config)).resolves.toBeDefined();
  });

  it('retains a concurrent caller pin when the shared setup finishes', async () => {
    vi.useFakeTimers();
    const opening = deferred(); mocks.createDriver.mockReturnValue(opening.promise);
    const mgr = manager();
    const first = mgr.acquire('conn:1', config);
    const pinned = mgr.acquire('conn:1', config, { pinned: true });
    opening.resolve(driver()); await Promise.all([first, pinned]);
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    expect(mgr.has('conn:1')).toBe(true);
  });

  it('does not discard the replacement when an older setup finishes after close', async () => {
    const old = deferred(); const replacement = driver();
    mocks.createDriver.mockReturnValueOnce(old.promise).mockResolvedValueOnce(replacement);
    const mgr = manager();
    const first = mgr.acquire('conn:1', config);
    const rejected = expect(first).rejects.toThrow(/closed during connection setup/);
    await Promise.resolve();
    const closing = mgr.closeKey('conn:1');
    const lease = await mgr.acquire('conn:1', config);
    const stale = driver(); old.resolve(stale);
    await closing; await rejected;
    expect(stale.close).toHaveBeenCalledOnce();
    expect(replacement.close).not.toHaveBeenCalled();
    expect(mgr.get('conn:1')).toBe(lease);
  });
});
