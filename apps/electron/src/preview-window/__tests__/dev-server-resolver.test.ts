import { describe, it, expect, vi } from 'vitest';
import {
  resolveDevUrl,
  pickDevRunner,
  type RunnerBridge,
  type ResolverRunnerTask,
} from '../dev-server-resolver.js';

function makeBridge(over: Partial<RunnerBridge> = {}): RunnerBridge {
  return {
    list: () => [],
    start: async () => { throw new Error('start not stubbed'); },
    stop: async () => undefined,
    detectDevCommand: async () => null,
    readBuffer: () => [],
    pinnedPort: () => null,
    ...over,
  };
}

function task(over: Partial<ResolverRunnerTask> = {}): ResolverRunnerTask {
  return {
    taskId: 't1',
    terminalId: 'term1',
    projectId: 1,
    status: 'running',
    command: 'npm run dev',
    label: 'dev',
    ...over,
  };
}

describe('resolveDevUrl — reuse', () => {
  it('reuses a running runner via the pinned port (no ownership, no terminal parse)', async () => {
    const bridge = makeBridge({
      list: () => [task()],
      pinnedPort: () => 5181,
      readBuffer: () => { throw new Error('should not read buffer when pinned'); },
    });
    const r = await resolveDevUrl(bridge, 1);
    expect(r).toEqual({ url: 'http://localhost:5181' });
    expect(r.ownedTaskId).toBeUndefined();
  });

  it('reuses a running runner by detecting the URL from its terminal (no pinned port)', async () => {
    const bridge = makeBridge({
      list: () => [task()],
      readBuffer: () => [{ type: 'data', data: '➜ Local: http://localhost:5174/\n' }],
    });
    const r = await resolveDevUrl(bridge, 1);
    expect(r).toEqual({ url: 'http://localhost:5174' });
  });

  it('errors when a runner is up but prints no URL (and no pinned port)', async () => {
    const bridge = makeBridge({
      list: () => [task()],
      readBuffer: () => [{ type: 'data', data: 'compiling...\n' }],
    });
    await expect(
      resolveDevUrl(bridge, 1, { reusePollMs: 20, pollIntervalMs: 5 }),
    ).rejects.toThrow(/no URL was detected/i);
  });

  it('ignores non-dev runner tasks (e.g. a build) and treats it as none running', async () => {
    const start = vi.fn(async () => task({ taskId: 'owned', terminalId: 'tOwned' }));
    const bridge = makeBridge({
      list: () => [task({ command: 'npm run build', label: 'build' })],
      pinnedPort: () => 5181,
      start,
      readBuffer: () => [{ type: 'data', data: 'ready in 200ms, Local: http://localhost:5181\n' }],
    });
    const r = await resolveDevUrl(bridge, 1);
    expect(start).toHaveBeenCalledOnce();
    expect(r.ownedTaskId).toBe('owned');
    expect(r.url).toBe('http://localhost:5181');
  });
});

describe('resolveDevUrl — start (owned)', () => {
  it('starts a tracked server when none is running and returns ownership', async () => {
    const start = vi.fn(async () => task({ taskId: 'owned', terminalId: 'tOwned' }));
    const bridge = makeBridge({
      list: () => [],
      detectDevCommand: async () => ({ command: 'pnpm dev', label: 'dev', manager: 'pnpm' }),
      start,
      readBuffer: () => [{ type: 'data', data: 'VITE ready  ➜ Local: http://localhost:5173/\n' }],
    });
    const r = await resolveDevUrl(bridge, 1);
    expect(start).toHaveBeenCalledWith({ projectId: 1, command: 'pnpm dev', label: 'dev', manager: 'pnpm' });
    expect(r).toEqual({ url: 'http://localhost:5173', ownedTaskId: 'owned' });
  });

  it('falls back to `npm run dev` when detection finds nothing', async () => {
    const start = vi.fn(async () => task({ taskId: 'owned', terminalId: 'tOwned' }));
    const bridge = makeBridge({
      list: () => [],
      detectDevCommand: async () => null,
      start,
      readBuffer: () => [{ type: 'data', data: 'Local: http://localhost:3000\n' }],
    });
    await resolveDevUrl(bridge, 1);
    expect(start).toHaveBeenCalledWith({ projectId: 1, command: 'npm run dev', label: 'dev', manager: 'npm' });
  });
});

describe('pickDevRunner', () => {
  it('prefers a script literally named dev', () => {
    expect(
      pickDevRunner([{ runners: [
        { id: 'npm:start', label: 'start', command: 'npm run start', manager: 'npm' },
        { id: 'npm:dev', label: 'dev', command: 'npm run dev', manager: 'npm' },
      ] }]),
    ).toEqual({ command: 'npm run dev', label: 'dev', manager: 'npm' });
  });

  it('falls back to any dev-server-ish command', () => {
    expect(
      pickDevRunner([{ runners: [{ id: 'npm:serve', label: 'serve', command: 'vite preview', manager: 'npm' }] }]),
    ).toEqual({ command: 'vite preview', label: 'serve', manager: 'npm' });
  });

  it('returns null when nothing looks like a dev server', () => {
    expect(pickDevRunner([{ runners: [{ id: 'npm:build', label: 'build', command: 'tsc -b', manager: 'npm' }] }])).toBeNull();
  });
});
