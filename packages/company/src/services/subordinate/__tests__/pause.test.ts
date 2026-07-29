/**
 * Tests for user-initiated pause and the completion-handler guard that
 * keeps a paused/aborted/deleted run from being clobbered to `error`
 * when the runner's `.done` settles afterwards.
 */
import { describe, expect, it, vi } from 'vitest';
import { pauseSubordinate } from '@mcp/company/services/subordinate/abort.js';
import { isUserStoppedRun } from '@mcp/company/services/subordinate/completion-handler.js';

const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000001';
const UNKNOWN_RUN_ID = '00000000-0000-4000-8000-000000000099';

function makePauseDeps() {
  const runnerAbort = vi.fn();
  const clearForAgent = vi.fn();
  const setStatus = vi.fn();
  const signal = vi.fn();
  const post = vi.fn();
  const subordinates = new Map<string, unknown>([
    [
      AGENT_RUN_ID,
      {
        agentRunId: AGENT_RUN_ID,
        role: 'frontend',
        runner: { abort: runnerAbort },
      },
    ],
  ]);
  const deps = {
    ctx: {},
    board: { post },
    status: { setStatus },
    humanInLoop: { clearForAgent },
    attention: { signal },
    subordinates,
    runningIds: new Set<string>([AGENT_RUN_ID]),
  } as never;
  return { deps, runnerAbort, clearForAgent, setStatus, signal };
}

describe('pauseSubordinate', () => {
  it('aborts the runner, flags status=paused, releases HitL, signals attention', () => {
    const { deps, runnerAbort, clearForAgent, setStatus, signal } = makePauseDeps();
    expect(pauseSubordinate(AGENT_RUN_ID, deps)).toBe(true);
    expect(runnerAbort).toHaveBeenCalledOnce();
    expect(clearForAgent).toHaveBeenCalledWith(AGENT_RUN_ID);
    expect(setStatus).toHaveBeenCalledWith(AGENT_RUN_ID, 'paused', 'Paused by user');
    expect(signal).toHaveBeenCalledWith({
      kind: 'finished',
      agentRunId: AGENT_RUN_ID,
      role: 'frontend',
    });
  });

  it('returns false for an unknown agentRunId without side effects', () => {
    const { deps, runnerAbort, setStatus } = makePauseDeps();
    expect(pauseSubordinate(UNKNOWN_RUN_ID, deps)).toBe(false);
    expect(runnerAbort).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe('isUserStoppedRun (completion-handler guard)', () => {
  const depsFor = (status: string | null) =>
    ({
      ctx: {
        companyFiles: {
          getAgentRunSync: () => (status == null ? null : { status }),
        },
      },
    } as never);

  it('treats paused / aborted / missing(deleted) runs as user-stopped', () => {
    expect(isUserStoppedRun(depsFor('paused'), AGENT_RUN_ID)).toBe(true);
    expect(isUserStoppedRun(depsFor('aborted'), AGENT_RUN_ID)).toBe(true);
    expect(isUserStoppedRun(depsFor(null), AGENT_RUN_ID)).toBe(true);
  });

  it('does NOT guard genuine in-flight / terminal failure states', () => {
    expect(isUserStoppedRun(depsFor('running'), AGENT_RUN_ID)).toBe(false);
    expect(isUserStoppedRun(depsFor('working'), AGENT_RUN_ID)).toBe(false);
    expect(isUserStoppedRun(depsFor('completed'), AGENT_RUN_ID)).toBe(false);
    expect(isUserStoppedRun(depsFor('error'), AGENT_RUN_ID)).toBe(false);
  });
});
