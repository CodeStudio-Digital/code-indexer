import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginExecution,
  debugSessionOutput,
  executionEntriesForProject,
  finishExecution,
  recordExecutionFailure,
  useExecutionOutput,
} from '../execution-output.js';

describe('execution output history', () => {
  beforeEach(() => {
    useExecutionOutput.getState().reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T12:00:00Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('retains the real output after an operation completes', () => {
    const id = beginExecution({
      projectId: 7,
      source: 'git',
      label: 'Git · push',
      command: 'git push origin main',
      status: 'running',
      output: '$ git push origin main\r\n',
    });
    finishExecution(id, {
      status: 'failed',
      output: '$ git push origin main\r\nrejected: non-fast-forward\r\n',
    });

    expect(executionEntriesForProject(useExecutionOutput.getState().entries, 7)).toMatchObject([{
      id,
      status: 'failed',
      output: expect.stringContaining('non-fast-forward'),
      completedAt: Date.now(),
    }]);
  });

  it('records failures that happen before a runner receives a terminal id', () => {
    recordExecutionFailure({
      projectId: 8,
      source: 'runner',
      label: 'Build',
      command: 'pnpm build',
      error: new Error('node-pty failed to load'),
    });

    expect(executionEntriesForProject(useExecutionOutput.getState().entries, 8)[0]).toMatchObject({
      source: 'runner',
      status: 'failed',
      output: expect.stringContaining('node-pty failed to load'),
    });
  });

  it('surfaces debugger startup diagnostics even when DAP produced no output events', () => {
    const output = debugSessionOutput({
      sessionId: 'debug-1',
      projectId: 9,
      adapterId: 'javascript',
      name: 'Debug dev',
      state: 'error',
      startedAt: Date.now(),
      output: [],
      error: 'debug adapter exited before accepting a connection\nnode:internal/modules/run_main:122',
    });

    expect(output).toContain('[error]');
    expect(output).toContain('debug adapter exited before accepting a connection');
    expect(output).toContain('node:internal/modules/run_main:122');
  });
});
