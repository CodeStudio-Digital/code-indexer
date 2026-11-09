import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }));

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
  unref = vi.fn();
}

describe('killProcessTree on Windows', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
  });

  it('returns asynchronously while keeping taskkill referenced until completion', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const { killProcessTree } = await import('../process-tree.js');

    const completion = killProcessTree(41_001, 'SIGKILL');

    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '41001', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true },
    );
    expect(child.unref).not.toHaveBeenCalled();
    child.emit('exit', 0, null);
    await completion;
  });

  it('deduplicates concurrent kills for the same process tree', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const { killProcessTree } = await import('../process-tree.js');

    const first = killProcessTree(41_002);
    const duplicate = killProcessTree(41_002);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    child.emit('exit', 0, null);
    await Promise.all([first, duplicate]);
    const next = killProcessTree(41_002);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    child.emit('exit', 0, null);
    await next;
  });

  it('terminates a taskkill helper that does not exit', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const { killProcessTree } = await import('../process-tree.js');

    const first = killProcessTree(41_003);
    const queued = killProcessTree(41_006);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([first, queued]);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // A timed-out helper opens the circuit instead of launching the queued
    // request into the same unhealthy Windows process enumerator.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('batches the exit-time sweep into one bounded helper', async () => {
    const { disposeTrackedProcessTreesSync, trackProcessTree } = await import('../process-tree.js');
    trackProcessTree(41_004);
    trackProcessTree(41_005);

    disposeTrackedProcessTreesSync();

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '41004', '/PID', '41005', '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 500,
        killSignal: 'SIGKILL',
      },
    );
  });
});
