import { describe, expect, it, vi } from 'vitest';
import { DevChildLifecycle } from '../dev-child-lifecycle.js';

function harness() {
  const killTree = vi.fn(async () => undefined);
  const killTreesSync = vi.fn();
  const lifecycle = new DevChildLifecycle(
    { electronPid: 41_001, dashboardPid: 41_002 },
    { killTree, killTreesSync },
  );
  return { lifecycle, killTree, killTreesSync };
}

describe('DevChildLifecycle', () => {
  it('kills the Vite tree when Electron closes normally', async () => {
    const { lifecycle, killTree } = harness();

    await expect(lifecycle.electronExited(0)).resolves.toBe(0);
    expect(killTree).toHaveBeenCalledOnce();
    expect(killTree).toHaveBeenCalledWith(41_002, 'SIGKILL');
  });

  it('kills Electron and fails the launcher when Vite exits unexpectedly', async () => {
    const { lifecycle, killTree } = harness();

    await expect(lifecycle.dashboardExited(0)).resolves.toBe(1);
    expect(killTree).toHaveBeenCalledWith(41_001, 'SIGKILL');
  });

  it('kills both trees on a terminal signal', async () => {
    const { lifecycle, killTree } = harness();

    await expect(lifecycle.signalReceived('SIGINT')).resolves.toBe(130);
    expect(killTree).toHaveBeenCalledWith(41_001, 'SIGKILL');
    expect(killTree).toHaveBeenCalledWith(41_002, 'SIGKILL');
  });

  it('runs only the first competing shutdown path', async () => {
    const { lifecycle, killTree } = harness();

    await expect(lifecycle.electronExited(0)).resolves.toBe(0);
    await expect(lifecycle.dashboardExited(1)).resolves.toBeNull();
    expect(killTree).toHaveBeenCalledTimes(1);
  });

  it('keeps a synchronous exit fallback for both process roots', () => {
    const { lifecycle, killTreesSync } = harness();

    lifecycle.forceCleanup();
    expect(killTreesSync).toHaveBeenCalledWith([41_001, 41_002]);
  });
});
