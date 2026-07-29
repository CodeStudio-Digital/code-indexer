import { describe, expect, it } from 'vitest';
import { asAgentRunId } from '@mcp/session-storage';
import { compareRunTerminalState } from '../run-state-comparator.js';

const DONE = { event: 'done' as const, reason: 'completed' };
const ERROR = { event: 'error' as const, reason: 'error' };
const RUN_ONE = asAgentRunId('11111111-1111-4111-8111-111111111111');
const RUN_TWO = asAgentRunId('22222222-2222-4222-8222-222222222222');
const RUN_GONE = asAgentRunId('99999999-9999-4999-8999-999999999999');

describe('compareRunTerminalState', () => {
  it('returns no divergences when legacy and control plane agree', () => {
    expect(compareRunTerminalState({
      legacy: DONE,
      command: { status: 'succeeded', reasonCode: 'completed', agentRunId: undefined },
      run: null,
    })).toEqual([]);
    expect(compareRunTerminalState({
      legacy: DONE,
      command: { status: 'succeeded', reasonCode: 'completed', agentRunId: RUN_ONE },
      run: { status: 'completed', terminalReason: 'completed' },
    })).toEqual([]);
    expect(compareRunTerminalState({
      legacy: ERROR,
      command: { status: 'failed', reasonCode: 'worker-crashed', agentRunId: RUN_ONE },
      run: { status: 'interrupted', terminalReason: 'worker-crashed' },
    })).toEqual([]);
    expect(compareRunTerminalState({
      legacy: { event: 'done', reason: 'max_turns' },
      command: { status: 'failed', reasonCode: 'max_turns', agentRunId: RUN_TWO },
      run: { status: 'interrupted', terminalReason: 'max_turns' },
    })).toEqual([]);
  });

  it('flags a missing command and, when linked, a missing run', () => {
    const missing = compareRunTerminalState({ legacy: DONE, command: null, run: null });
    expect(missing).toHaveLength(1);
    expect(missing[0].kind).toBe('missing_command');

    const missingRun = compareRunTerminalState({
      legacy: DONE,
      command: { status: 'succeeded', reasonCode: 'completed', agentRunId: RUN_GONE },
      run: null,
    });
    expect(missingRun).toHaveLength(1);
    expect(missingRun[0].kind).toBe('missing_run');
  });

  it('flags terminal mismatches between legacy and control plane', () => {
    const divergences = compareRunTerminalState({
      legacy: DONE,
      command: { status: 'failed', reasonCode: 'boom', agentRunId: RUN_ONE },
      run: { status: 'failed', terminalReason: 'boom' },
    });
    expect(divergences.map((d) => d.kind)).toEqual([
      'command_status_mismatch',
      'run_status_mismatch',
    ]);
    expect(divergences[0].detail).toContain('expected one of succeeded');
    expect(divergences[1].detail).toContain('expected one of completed');
  });

  it('flags non-terminal control-plane rows after a legacy terminal event', () => {
    const divergences = compareRunTerminalState({
      legacy: ERROR,
      command: { status: 'running', reasonCode: undefined, agentRunId: RUN_ONE },
      run: { status: 'running', terminalReason: undefined },
    });
    expect(divergences.map((d) => d.kind)).toEqual([
      'command_not_terminal',
      'run_not_terminal',
    ]);
  });
});
