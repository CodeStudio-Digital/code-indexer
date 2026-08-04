import type { SessionState, StreamBlock } from './types.js';

/**
 * Build the terminal UI state used when the server acknowledged Stop but the
 * stream never delivered its final operation/done events. Keep completed
 * content visible, but freeze every still-live block so no row can remain in a
 * misleading "running" state after the composer has returned to Send.
 */
export function createAbortedSessionPatch(
  state: SessionState,
  now = Date.now(),
): Partial<SessionState> {
  const currentTurn = state.currentTurn
    ? { blocks: state.currentTurn.blocks.map((block) => abortBlock(block, now)) }
    : null;
  return {
    streaming: false,
    currentTurn,
    doneReason: 'aborted',
    interactionPending: null,
    activeProcesses: [],
    pendingApprovals: [],
    preflight: null,
  };
}

function abortBlock(block: StreamBlock, now: number): StreamBlock {
  if (block.type === 'activity' && block.status === 'running') {
    return {
      ...block,
      status: 'aborted',
      phase: 'aborted',
      note: undefined,
      lastEventAt: now,
      elapsedMs: Math.max(block.elapsedMs ?? 0, now - block.startedAt),
      idleMs: undefined,
      deadlineMs: undefined,
    };
  }

  if (
    block.type === 'tool'
    && (block.call.status === 'running' || block.call.status === 'awaiting_approval')
  ) {
    return {
      ...block,
      call: {
        ...block.call,
        status: 'error',
        durationMs: block.call.startedAt
          ? Math.max(block.call.durationMs ?? 0, now - block.call.startedAt)
          : block.call.durationMs,
        elapsedMs: undefined,
        progressNote: undefined,
        approvals: undefined,
      },
    };
  }

  if (block.type === 'task_run' && block.run.status === 'running') {
    const finishedAt = new Date(now).toISOString();
    return {
      ...block,
      run: {
        ...block.run,
        status: 'aborted',
        finishedAt,
        tasks: block.run.tasks.map((task) => {
          if (task.status === 'pending') return { ...task, status: 'skipped', finishedAt };
          if (task.status === 'running') return { ...task, status: 'interrupted', finishedAt };
          return task;
        }),
      },
    };
  }

  if (block.type === 'agents' && block.group.status === 'running') {
    return {
      ...block,
      group: {
        ...block.group,
        status: 'completed',
        agents: block.group.agents.map((agent) => (
          agent.status === 'pending' || agent.status === 'running'
            ? { ...agent, status: 'aborted' as const }
            : agent
        )),
      },
    };
  }

  return block;
}
