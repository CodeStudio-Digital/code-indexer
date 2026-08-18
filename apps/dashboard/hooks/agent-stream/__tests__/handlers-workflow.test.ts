import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import type { StreamBlock, UpdateSession, WorkflowRunState } from '../types.js';

function setup() {
  const blocks: StreamBlock[] = [];
  const toolIndex = new Map<string, number>();
  const flush = vi.fn();
  const flushNow = vi.fn();
  const updateSession: UpdateSession = vi.fn();
  const handlers = createEventHandlers({
    sid: 1,
    blocks,
    toolIndex,
    flush,
    flushNow,
    updateSession,
  });
  return { handlers, blocks, toolIndex, flush, flushNow, updateSession };
}

function startWorkflow(handlers: ReturnType<typeof setup>['handlers']) {
  handlers.workflow_run_started(
    {
      workflow_id: 'wf_abc12345',
      name: 'audit fluxo de auth',
      total_waves: 2,
      steps: [
        { id: 'scan', title: 'Scan', profile: 'explore', depends_on: [], wave: 1, status: 'pending' },
        { id: 'fix', title: 'Fix', profile: 'implement', depends_on: ['scan'], wave: 2, status: 'pending' },
      ],
    },
    'workflow_run_started',
  );
}

describe('workflow handlers', () => {
  it('creates the workflow card and applies step transitions', () => {
    const { handlers, blocks } = setup();
    startWorkflow(handlers);

    expect(blocks[0]).toMatchObject({
      type: 'workflow',
      run: {
        workflowId: 'wf_abc12345',
        status: 'running',
        totalWaves: 2,
        steps: [
          { id: 'scan', status: 'pending', wave: 1 },
          { id: 'fix', status: 'pending', wave: 2, dependsOn: ['scan'] },
        ],
      },
    });

    handlers.workflow_step_update(
      { workflow_id: 'wf_abc12345', step_id: 'scan', status: 'running', group_id: 'wf1-wf_abc12345-w1' },
      'workflow_step_update',
    );
    handlers.workflow_step_update(
      {
        workflow_id: 'wf_abc12345',
        step_id: 'scan',
        status: 'completed',
        summary: 'achou 3 pontos',
        tool_call_count: 12,
      },
      'workflow_step_update',
    );
    handlers.workflow_run_finished(
      { workflow_id: 'wf_abc12345', status: 'completed', total_usage: { input_tokens: 10, output_tokens: 5 } },
      'workflow_run_finished',
    );

    const run = (blocks[0] as { type: 'workflow'; run: WorkflowRunState }).run;
    expect(run.steps[0]).toMatchObject({ status: 'completed', summary: 'achou 3 pontos', toolCallCount: 12 });
    expect(run.status).toBe('completed');
    expect(run.totalUsage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('folds workflow-wave agent progress into the step row and suppresses the agents card', () => {
    const { handlers, blocks } = setup();
    startWorkflow(handlers);

    handlers.agents_group_start(
      {
        groupId: 'wf1-wf_abc12345-w1',
        agents: [{ index: 0, label: 'scan' }],
      },
      'agents_group_start',
    );
    // No second card — the workflow block stays the only one.
    expect(blocks.filter((b) => b.type === 'agents')).toHaveLength(0);

    handlers.agent_progress(
      {
        groupId: 'wf1-wf_abc12345-w1',
        agentIndex: 0,
        label: 'scan',
        event: 'tool_call',
        toolCallCount: 7,
        lastToolName: 'grep_code',
        limit: { maxToolCalls: 80 },
      },
      'agent_progress',
    );
    const run = (blocks[0] as { type: 'workflow'; run: WorkflowRunState }).run;
    expect(run.steps[0]).toMatchObject({
      toolCallCount: 7,
      lastToolName: 'grep_code',
      maxToolCalls: 80,
      groupId: 'wf1-wf_abc12345-w1',
    });

    handlers.agents_group_end(
      { groupId: 'wf1-wf_abc12345-w1', totalUsage: { input_tokens: 1, output_tokens: 1 } },
      'agents_group_end',
    );
    expect(blocks.filter((b) => b.type === 'agents')).toHaveLength(0);
  });

  it('merges a resume re-emit into the existing card, keeping terminal results', () => {
    const { handlers, blocks } = setup();
    startWorkflow(handlers);
    handlers.workflow_step_update(
      { workflow_id: 'wf_abc12345', step_id: 'scan', status: 'completed', summary: 'ok' },
      'workflow_step_update',
    );
    handlers.workflow_run_started(
      {
        workflow_id: 'wf_abc12345',
        name: 'audit fluxo de auth',
        resumed: true,
        total_waves: 2,
        steps: [
          { id: 'scan', title: 'Scan', profile: 'explore', depends_on: [], wave: 1, status: 'completed' },
          { id: 'fix', title: 'Fix', profile: 'implement', depends_on: ['scan'], wave: 2, status: 'pending' },
        ],
      },
      'workflow_run_started',
    );
    expect(blocks.filter((b) => b.type === 'workflow')).toHaveLength(1);
    const run = (blocks[0] as { type: 'workflow'; run: WorkflowRunState }).run;
    expect(run.resumed).toBe(true);
    expect(run.steps[0]).toMatchObject({ status: 'completed', summary: 'ok' });
  });

  it('renders the per-turn Ultra chip on run_started', () => {
    const { handlers, blocks } = setup();
    handlers.run_started({ runId: 'r1', ultra: 'turn' }, 'run_started');
    // A `notice`, never a `text` block: history does not persist this, and text
    // the durable run cannot contain breaks the live⇄persisted comparison.
    expect(blocks.some((b) => b.type === 'notice' && b.notice.kind === 'ultra_turn')).toBe(true);
    expect(blocks.some((b) => b.type === 'text')).toBe(false);
    // Session-scope ultra renders no chip (it would spam every run).
    const second = setup();
    second.handlers.run_started({ runId: 'r2', ultra: 'session' }, 'run_started');
    expect(second.blocks).toHaveLength(0);
  });
});
