import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ child: undefined as EventEmitter | undefined, kill: vi.fn(), untrack: vi.fn(), mode: 'ready' }));
vi.mock('node:child_process', () => ({
  fork: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, stderr: null });
    state.child = child;
    queueMicrotask(() => {
      if (state.mode === 'ready') child.emit('message', 'database-ready');
      if (state.mode === 'error') child.emit('error', new Error('spawn failed'));
    });
    return child;
  }),
}));
vi.mock('@mcp/shared/utils/process-tree.js', () => ({
  trackProcessTree: () => state.untrack,
  killProcessTree: async (pid: number) => { state.kill(pid); state.child?.emit('close', 1); },
}));
import { initializeDatabaseForStartup } from '../database-startup.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); state.mode = 'ready'; });
it('joins termination after the closed-database receipt if native cleanup does not exit', async () => {
  await initializeDatabaseForStartup(resolve('fixture/startup.db'));
  expect(state.kill).toHaveBeenCalledWith(12345);
  expect(state.untrack).toHaveBeenCalledOnce();
});
it('retires a failed child before rejecting startup', async () => {
  state.mode = 'error';
  await expect(initializeDatabaseForStartup(resolve('fixture/failure.db'))).rejects.toThrow('spawn failed');
  expect(state.kill).toHaveBeenCalledWith(12345);
});
it('bounds a child that never sends readiness', async () => {
  vi.useFakeTimers(); state.mode = 'silent';
  const outcome = initializeDatabaseForStartup(resolve('fixture/hung.db')).catch(error => error);
  await vi.advanceTimersByTimeAsync(180_010);
  expect((await outcome).message).toContain('exceeded 180 seconds');
  expect(state.kill).toHaveBeenCalledWith(12345);
});