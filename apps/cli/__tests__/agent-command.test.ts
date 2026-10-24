import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(), shutdown: vi.fn(),
  create: vi.fn(() => ({ app: { request: vi.fn() }, db: { listProjects: () => [{ id: 1, name: 'fixture', root_path: process.cwd() }] },
    deps: {}, mcpPool: {}, chromeService: {} })),
}));
vi.mock('../../http-api/server.js', () => ({ createApp: mocks.create }));
vi.mock('../../http-api/server/runtime-shutdown.js', () => ({ shutdownAppRuntime: mocks.shutdown }));
vi.mock('../commands/agent-session-client.js', () => ({ runAgentSession: mocks.run }));
vi.mock('../helpers.js', () => ({ promptStdin: vi.fn() }));
import { runAgentCommand } from '../commands/agent-command.js';

afterEach(() => { vi.clearAllMocks(); });
it('drains the owned runtime before a successful command returns', async () => {
  const order: string[] = [];
  mocks.run.mockImplementationOnce(async () => { order.push('terminal'); return { classification: 'completed' }; });
  mocks.shutdown.mockImplementationOnce(async () => { await Promise.resolve(); order.push('shutdown'); });
  expect(await runAgentCommand('task', { provider: 'fixture' })).toBe(0);
  expect(order).toEqual(['terminal', 'shutdown']);
});
it('releases resources and signal listeners after a rejected stream', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  mocks.run.mockRejectedValueOnce(new Error('stream lost'));
  await expect(runAgentCommand('task', { provider: 'fixture' })).rejects.toThrow('stream lost');
  expect(mocks.shutdown).toHaveBeenCalledTimes(1);
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});
it('drains startup resources even when the selected project does not exist', async () => {
  await expect(runAgentCommand('task', { provider: 'fixture', project: 'missing' })).rejects.toThrow('not found');
  expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.shutdown).toHaveBeenCalledTimes(1);
});
it.each([['cancelled', 130], ['failed', 1], ['interrupted', 1]])('returns a non-success status for %s', async (classification, expected) => {
  mocks.run.mockResolvedValueOnce({ classification });
  expect(await runAgentCommand('task', { provider: 'fixture' })).toBe(expected);
});
