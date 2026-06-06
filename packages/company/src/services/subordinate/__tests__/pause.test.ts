/**
 * Tests for user-initiated pause and the completion-handler guard that
 * keeps a paused/aborted/deleted run from being clobbered to `error`
 * when the runner's `.done` settles afterwards.
 */
import { describe, expect, it, vi } from 'vitest';
import { pauseSubordinate } from '@mcp/company/services/subordinate/abort.js';
import { isUserStoppedRun } from '@mcp/company/services/subordinate/completion-handler.js';

function makePauseDeps() {
  const runnerAbort = vi.fn();
  const clearForAgent = vi.fn();
  const setStatus = vi.fn();
  const signal = vi.fn();
  const post = vi.fn();
  const subordinates = new Map<number, unknown>([
    [1, { agentRunId: 1, role: 'frontend', runner: { abort: runnerAbort } }],
  ]);
  const deps = {
    ctx: {},
    board: { post },
    status: { setStatus },
    humanInLoop: { clearForAgent },
    attention: { signal },
    subordinates,
    runningIds: new Set<number>([1]),
  } as never;
  return { deps, runnerAbort, clearForAgent, setStatus, signal };
}

describe('pauseSubordinate', () => {
  it('aborts the runner, flags status=paused, releases HitL, signals attention', () => {
    const { deps, runnerAbort, clearForAgent, setStatus, signal } = makePauseDeps();
    expect(pauseSubordinate(1, deps)).toBe(true);
    expect(runnerAbort).toHaveBeenCalledOnce();
    expect(clearForAgent).toHaveBeenCalledWith(1);
    expect(setStatus).toHaveBeenCalledWith(1, 'paused', 'Paused by user');
    expect(signal).toHaveBeenCalledWith({ kind: 'finished', agentRunId: 1, role: 'frontend' });
  });

  it('returns false for an unknown agentRunId without side effects', () => {
    const { deps, runnerAbort, setStatus } = makePauseDeps();
    expect(pauseSubordinate(99, deps)).toBe(false);
    expect(runnerAbort).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe('isUserStoppedRun (completion-handler guard)', () => {
  const depsFor = (status: string | null) =>
    ({ ctx: { companyStore: { getAgentRun: () => (status == null ? null : { status }) } } } as never);

  it('treats paused / aborted / missing(deleted) runs as user-stopped', () => {
    expect(isUserStoppedRun(depsFor('paused'), 1)).toBe(true);
    expect(isUserStoppedRun(depsFor('aborted'), 1)).toBe(true);
    expect(isUserStoppedRun(depsFor(null), 1)).toBe(true);
  });

  it('does NOT guard genuine in-flight / terminal failure states', () => {
    expect(isUserStoppedRun(depsFor('running'), 1)).toBe(false);
    expect(isUserStoppedRun(depsFor('working'), 1)).toBe(false);
    expect(isUserStoppedRun(depsFor('completed'), 1)).toBe(false);
    expect(isUserStoppedRun(depsFor('error'), 1)).toBe(false);
  });
});
