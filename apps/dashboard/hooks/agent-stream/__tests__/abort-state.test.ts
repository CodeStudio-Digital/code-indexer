import { describe, expect, it } from 'vitest';
import { createAbortedSessionPatch } from '../abort-state.js';
import { EMPTY_STATE, type SessionState } from '../types.js';

describe('createAbortedSessionPatch', () => {
  it('freezes provider and tool rows instead of leaving them running', () => {
    const state: SessionState = {
      ...EMPTY_STATE,
      streaming: true,
      activeProcesses: [{
        id: 'provider-chat:run:1',
        source: 'provider',
        kind: 'provider',
        label: 'chatgpt:gpt-5.6-sol',
        status: 'running',
        startedAt: 1_000,
        updatedAt: 5_000,
      }],
      pendingApprovals: [{
        toolUseId: 'tool-1',
        toolName: 'code_exec',
        argsSummary: 'script',
        riskClass: 'execute',
        approvalKind: 'standard',
        receivedAt: 4_000,
      }],
      currentTurn: {
        blocks: [
          {
            type: 'activity',
            id: 'provider-chat:run:1',
            kind: 'provider',
            label: 'chatgpt:gpt-5.6-sol',
            status: 'running',
            startedAt: 1_000,
            lastEventAt: 5_000,
            note: 'calling provider with 48 tools',
          },
          {
            type: 'tool',
            call: {
              id: 'tool-1',
              name: 'code_exec',
              status: 'awaiting_approval',
              startedAt: 2_000,
            },
          },
        ],
      },
    };

    const patch = createAbortedSessionPatch(state, 6_000);
    const blocks = patch.currentTurn?.blocks ?? [];

    expect(patch).toMatchObject({
      streaming: false,
      doneReason: 'aborted',
      activeProcesses: [],
      pendingApprovals: [],
      preflight: null,
    });
    expect(blocks[0]).toMatchObject({
      type: 'activity',
      status: 'aborted',
      phase: 'aborted',
      note: undefined,
      elapsedMs: 5_000,
    });
    expect(blocks[1]).toMatchObject({
      type: 'tool',
      call: { status: 'error', durationMs: 4_000, approvals: undefined },
    });
    expect(state.currentTurn?.blocks[0]).toMatchObject({ status: 'running' });
  });

  it('terminates nested task and agent runtime state', () => {
    const state: SessionState = {
      ...EMPTY_STATE,
      streaming: true,
      currentTurn: {
        blocks: [
          {
            type: 'task_run',
            run: {
              runId: 'tasks-1',
              mode: 'auto',
              status: 'running',
              totalTasks: 2,
              waves: [],
              tasks: [
                { id: 'a', title: 'A', kind: 'implement', wave: 0, mode: 'inline', status: 'running', toolCallCount: 1 },
                { id: 'b', title: 'B', kind: 'verify', wave: 1, mode: 'inline', status: 'pending', toolCallCount: 0 },
              ],
            },
          },
          {
            type: 'agents',
            group: {
              groupId: 'agents-1',
              status: 'running',
              agents: [
                { index: 0, label: 'Scout', status: 'running', toolCallCount: 2 },
              ],
            },
          },
        ],
      },
    };

    const patch = createAbortedSessionPatch(state, Date.parse('2026-07-19T12:00:00.000Z'));
    const blocks = patch.currentTurn?.blocks ?? [];

    expect(blocks[0]).toMatchObject({
      type: 'task_run',
      run: {
        status: 'aborted',
        tasks: [{ status: 'interrupted' }, { status: 'skipped' }],
      },
    });
    expect(blocks[1]).toMatchObject({
      type: 'agents',
      group: { status: 'completed', agents: [{ status: 'aborted' }] },
    });
  });
});
