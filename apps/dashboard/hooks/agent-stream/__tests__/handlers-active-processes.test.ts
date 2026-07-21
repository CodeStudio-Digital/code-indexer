import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import { EMPTY_STATE, type SessionState, type StreamBlock, type UpdateSession } from '../types.js';

function setup() {
  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();
  let state: SessionState = { ...EMPTY_STATE, activeProcesses: [] };
  const updateSession: UpdateSession = vi.fn((_sid, patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
  });
  const handlers = createEventHandlers({
    sid: 7,
    blocks,
    toolIndex,
    flush: vi.fn(),
    flushNow: vi.fn(),
    updateSession,
  });
  return { handlers, getState: () => state };
}

describe('active process event lifecycle', () => {
  it('adds, updates, waits, resumes, and removes a tool process', () => {
    const { handlers, getState } = setup();
    handlers.tool_call_start({ id: 't1', name: 'code_exec', input: {} }, 'tool_call_start');
    expect(getState().activeProcesses).toMatchObject([
      { id: 'tool:t1', source: 'tool', label: 'code_exec', status: 'running' },
    ]);

    handlers.tool_progress({
      id: 't1', name: 'code_exec', elapsedMs: 2_000, idleMs: 1_500,
      kind: 'heartbeat', note: 'running tests',
    }, 'tool_progress');
    expect(getState().activeProcesses[0]).toMatchObject({
      elapsedMs: 2_000, idleMs: 1_500, note: 'running tests',
    });

    handlers.tool_approval_request({
      toolUseId: 't1',
      toolName: 'db_query',
      input: { connection: 'Dellsoft', sql: 'DELETE FROM users WHERE id = 7' },
    }, 'tool_approval_request');
    expect(getState().activeProcesses[0].status).toBe('waiting');
    expect(getState().pendingApprovals[0]?.input).toEqual({
      connection: 'Dellsoft',
      sql: 'DELETE FROM users WHERE id = 7',
    });
    handlers.tool_approval_resolved({ toolUseId: 't1' }, 'tool_approval_resolved');
    expect(getState().activeProcesses[0].status).toBe('running');

    handlers.tool_call_result({ id: 't1', duration_ms: 3_000, result: { content: 'ok' } }, 'tool_call_result');
    expect(getState().activeProcesses).toEqual([]);
  });

  it('keeps background subagents across message_complete and removes them at termination', () => {
    const { handlers, getState } = setup();
    handlers.tool_call_start({ id: 'spawn', name: 'spawn_agent', input: { background: true } }, 'tool_call_start');
    handlers.agents_group_start({
      groupId: 'g1',
      jobId: 'job-1',
      background: true,
      agents: [
        { index: 0, label: 'Scout API', status: 'pending' },
        { index: 1, label: 'Scout DB', status: 'pending' },
      ],
    }, 'agents_group_start');

    expect(getState().activeProcesses).toHaveLength(2);
    expect(getState().activeProcesses.every((process) => process.background)).toBe(true);
    handlers.message_complete({}, 'message_complete');
    expect(getState().activeProcesses).toHaveLength(2);

    handlers.agent_progress({
      groupId: 'g1', agentIndex: 0, label: 'Scout API', event: 'completed',
    }, 'agent_progress');
    expect(getState().activeProcesses.map((process) => process.label)).toEqual(['Scout DB']);
    handlers.agents_group_end({ groupId: 'g1' }, 'agents_group_end');
    expect(getState().activeProcesses).toEqual([]);
  });

  it('tracks provider, generic operation, and task lifecycles without completed residue', () => {
    const { handlers, getState } = setup();
    handlers.provider_call({ runId: 'r1', turn: 1, provider: 'openai', model: 'gpt' }, 'provider_call');
    expect(getState().activeProcesses[0]).toMatchObject({ source: 'provider', kind: 'provider' });
    handlers.text({ text: 'response' }, 'text');
    expect(getState().activeProcesses).toEqual([]);

    handlers.operation_started({ opId: 'op:1', kind: 'operation', label: 'Indexing' }, 'operation_started');
    expect(getState().activeProcesses[0].label).toBe('Indexing');
    handlers.operation_finished({ opId: 'op:1', kind: 'operation', label: 'Indexing', status: 'completed' }, 'operation_finished');
    expect(getState().activeProcesses).toEqual([]);

    handlers.task_run_task_started({
      run_id: 'run-1', task_id: 'task-1', title: 'Verify build', kind: 'verify', wave: 0,
      mode: 'subagent', started_at: '2026-07-14T12:00:00.000Z',
    }, 'task_run_task_started');
    expect(getState().activeProcesses[0]).toMatchObject({ source: 'task', label: 'Verify build' });
    handlers.agents_group_start({
      groupId: 'tasks-wave-example', agents: [{ index: 0, label: 'verify:task-1' }],
    }, 'agents_group_start');
    handlers.agent_progress({
      groupId: 'tasks-wave-example', agentIndex: 0, label: 'verify:task-1', event: 'heartbeat',
      status: 'running', note: 'checking build',
    }, 'agent_progress');
    expect(getState().activeProcesses).toMatchObject([
      { source: 'task', kind: 'subagent', label: 'Verify build' },
    ]);
    handlers.task_run_task_finished({
      run_id: 'run-1', task_id: 'task-1', status: 'done', summary: 'ok',
      finished_at: '2026-07-14T12:00:01.000Z',
    }, 'task_run_task_finished');
    expect(getState().activeProcesses).toEqual([]);
  });
});
