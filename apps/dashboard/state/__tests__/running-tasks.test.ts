import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerTask } from '@mcp/api-bus';
import { apiCall } from '../../lib/api-client.js';
import { dismissTask, restartTask, startSnippet, startTask, stopTask, useRunningTasks } from '../running-tasks.js';
import { useExecutionOutput } from '../execution-output.js';

vi.mock('../../lib/api-client.js', () => ({ apiCall: vi.fn(), apiStream: vi.fn(), electronApi: () => null }));

const task: RunnerTask = {
  taskId: 'run-1', terminalId: 'pty-1', projectId: 7, projectName: 'fixture',
  command: 'npm run dev', label: 'dev', manager: 'npm', status: 'running', exitCode: null, startedAt: 1,
};
const input = { projectId: task.projectId, command: task.command, label: task.label, manager: task.manager };

beforeEach(() => {
  vi.resetAllMocks();
  useRunningTasks.setState({ tasks: [], started: false });
  useExecutionOutput.getState().reset();
});

describe('runner RPC results while the event stream is unavailable', () => {
  it('publishes the confirmed task and its terminal before the caller selects it', async () => {
    vi.mocked(apiCall).mockResolvedValue(task);
    const result = await startTask(input);
    expect(useRunningTasks.getState().tasks).toEqual([result]);
    expect(result.terminalId).toBe('pty-1');
  });

  it('does not resurrect or duplicate a task whose exit event beat the start reply', async () => {
    vi.mocked(apiCall).mockImplementation(async () => {
      useRunningTasks.getState().setTasks([{ ...task, status: 'exited', exitCode: 0 }]);
      return task;
    });
    await startTask(input);
    expect(useRunningTasks.getState().tasks).toEqual([{ ...task, status: 'exited', exitCode: 0 }]);
  });

  it('publishes snippet launches too', async () => {
    vi.mocked(apiCall).mockResolvedValue(task);
    await startSnippet({ projectId: 7, language: 'js', code: 'console.log(1)', label: 'example' });
    expect(useRunningTasks.getState().tasks).toEqual([task]);
  });

  it('applies confirmed stop, restart and dismiss without waiting for snapshots', async () => {
    useRunningTasks.getState().setTasks([task]);
    vi.mocked(apiCall).mockResolvedValue(undefined);
    await stopTask(task.taskId);
    expect(useRunningTasks.getState().tasks[0]?.status).toBe('stopped');
    const restarted = { ...task, taskId: 'run-2', terminalId: 'pty-2' };
    vi.mocked(apiCall).mockResolvedValue(restarted);
    await restartTask(task.taskId);
    expect(useRunningTasks.getState().tasks).toEqual([restarted]);
    await dismissTask(restarted.taskId);
    expect(useRunningTasks.getState().tasks).toEqual([]);
  });

  it('preserves diagnostics and does not invent a task when spawning fails', async () => {
    vi.mocked(apiCall).mockRejectedValue(new Error('shell executable missing'));
    await expect(startTask(input)).rejects.toThrow('shell executable missing');
    expect(useRunningTasks.getState().tasks).toEqual([]);
    expect(useExecutionOutput.getState().entries[0]).toMatchObject({
      source: 'runner', status: 'failed', output: expect.stringContaining('shell executable missing'),
    });
  });

  it('does not show a successful stop or dismissal when the backend rejects it', async () => {
    useRunningTasks.getState().setTasks([task]);
    vi.mocked(apiCall).mockRejectedValue(new Error('IPC unavailable'));
    await expect(stopTask(task.taskId)).rejects.toThrow('IPC unavailable');
    await expect(dismissTask(task.taskId)).rejects.toThrow('IPC unavailable');
    expect(useRunningTasks.getState().tasks).toEqual([task]);
  });
});
