import { expect, it, vi } from 'vitest';
import { NativePreviewServers } from '../native-preview-server.js';
import type { NativeHostDuplexProcess } from '@mcp/agent-runtime-host';

function fixture(reaped = true) {
  let finish!: () => void;
  const exit = new Promise<void>(resolve => { finish = resolve; });
  const owner = { processId: 123, cancel: vi.fn(),
    readOutput: async () => { await exit; return null; },
    wait: async () => { await exit; return { processId: 123, reaped, exitCode: 0, cancelled: true }; },
  } as unknown as NativeHostDuplexProcess;
  const spawn = vi.fn(() => owner), controller = new AbortController();
  const scope = new NativePreviewServers(spawn, 'D:/fixture', 7, Date.now() + 60_000, controller.signal);
  return { finish, owner, spawn, controller, scope, runner: scope.forInvocation(() => {}) };
}
const input = { projectId: 7, command: 'npm run dev', label: 'dev', manager: 'npm' };
it('does not acknowledge stop until the contained server is physically reaped', async () => {
  const f = fixture(); const task = await f.runner.start(input);
  let closed = false;
  const closing = f.runner.stop(task.taskId).then(() => { closed = true; });
  await Promise.resolve();
  expect(f.owner.cancel).toHaveBeenCalled(); expect(closed).toBe(false);
  f.finish(); await closing; await f.scope.close();
  expect(await f.runner.list()).toEqual([]);
});
it('fences the synchronous spawn and refuses another project', async () => {
  const f = fixture();
  await expect(f.runner.start({ ...input, projectId: 8 })).rejects.toThrow('project');
  const fenced = f.scope.forInvocation(() => { throw new Error('revoked'); });
  await expect(fenced.start(input)).rejects.toThrow('revoked');
  expect(f.spawn).not.toHaveBeenCalled(); await f.scope.close();
});
it('cancels on attempt loss and retains cleanup uncertainty', async () => {
  const f = fixture(false); await f.runner.start(input);
  f.controller.abort(); expect(f.owner.cancel).toHaveBeenCalled();
  f.finish(); await expect(f.scope.close()).rejects.toThrow('unconfirmed');
  expect(await f.runner.list()).toHaveLength(1);
});
