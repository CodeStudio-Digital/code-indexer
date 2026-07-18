import { describe, expect, it, vi } from 'vitest';
import { createEventHandlers } from '../handlers.js';
import type { AgentsGroup, StreamBlock, UpdateSession } from '../types.js';

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
  return { handlers, blocks, flush };
}

function group(blocks: StreamBlock[]): AgentsGroup {
  const block = blocks.find((b) => b.type === 'agents');
  if (!block || block.type !== 'agents') throw new Error('expected agents block');
  return block.group;
}

describe('agent_progress handlers', () => {
  it('replaces group and agent objects so memoized UI re-renders live progress', () => {
    const { handlers, blocks, flush } = setup();
    handlers.agents_group_start(
      {
        groupId: 'grp_1',
        provider: 'zai',
        model: 'glm-5',
        agents: [{
          index: 0,
          label: 'Explore HTTP',
          researchDepth: 'quick',
          softToolTarget: 16,
          softTimeTargetMs: 180_000,
        }],
      },
      'agents_group_start',
    );
    const beforeGroup = group(blocks);
    const beforeAgent = beforeGroup.agents[0];
    flush.mockClear();

    handlers.agent_progress(
      {
        groupId: 'grp_1',
        agentIndex: 0,
        label: 'Explore HTTP',
        event: 'heartbeat',
        status: 'running',
        phase: 'thinking_delta',
        note: 'thinking',
        toolCallCount: 3,
        elapsedMs: 10_000,
        idleMs: 1_000,
        deadlineMs: 120_000,
        lastToolName: 'read_file',
      },
      'agent_progress',
    );

    const afterGroup = group(blocks);
    const afterAgent = afterGroup.agents[0];
    expect(afterGroup).not.toBe(beforeGroup);
    expect(afterAgent).not.toBe(beforeAgent);
    expect(afterAgent).toMatchObject({
      status: 'running',
      phase: 'thinking_delta',
      progressNote: 'thinking',
      toolCallCount: 3,
      lastToolName: 'read_file',
      researchDepth: 'quick',
      softToolTarget: 16,
      softTimeTargetMs: 180_000,
    });
    expect(beforeAgent.phase).toBeUndefined();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('carries each agent task from group_start into the agent row', () => {
    const { handlers, blocks } = setup();
    handlers.agents_group_start(
      {
        groupId: 'grp_1',
        provider: 'zai',
        model: 'glm-5',
        agents: [
          { index: 0, label: 'Explore HTTP', task: 'Map the HTTP layer' },
          { index: 1, label: 'Explore DB', task: 'Map the DB layer' },
        ],
      },
      'agents_group_start',
    );

    const g = group(blocks);
    expect(g.agents[0].task).toBe('Map the HTTP layer');
    expect(g.agents[1].task).toBe('Map the DB layer');
  });

  it('replaces the group object when the group finishes', () => {
    const { handlers, blocks } = setup();
    handlers.agents_group_start(
      {
        groupId: 'grp_1',
        agents: [{ index: 0, label: 'Explore HTTP' }],
      },
      'agents_group_start',
    );
    const beforeGroup = group(blocks);

    handlers.agents_group_end(
      {
        groupId: 'grp_1',
        totalUsage: { input_tokens: 10, output_tokens: 2 },
      },
      'agents_group_end',
    );

    const afterGroup = group(blocks);
    expect(afterGroup).not.toBe(beforeGroup);
    expect(afterGroup.status).toBe('completed');
    expect(afterGroup.totalUsage).toEqual({ input_tokens: 10, output_tokens: 2 });
  });

  it('stores the latest tool_call note on the owning agent only', () => {
    const { handlers, blocks } = setup();
    handlers.agents_group_start(
      {
        groupId: 'grp_1',
        agents: [{ index: 0, label: 'Explore HTTP' }],
      },
      'agents_group_start',
    );

    handlers.agent_progress(
      {
        groupId: 'grp_1',
        agentIndex: 0,
        label: 'Explore HTTP',
        event: 'tool_call',
        status: 'running',
        phase: 'tool_call',
        note: 'glob completed',
        toolCallCount: 4,
        lastToolName: 'glob',
      },
      'agent_progress',
    );

    expect(group(blocks).agents[0]).toMatchObject({
      phase: 'tool_call',
      progressNote: 'glob completed',
      lastToolName: 'glob',
      toolCallCount: 4,
    });
    expect(blocks.some((block) => block.type === 'activity')).toBe(false);
  });

  it('keeps an operational cutoff visible as a terminal partial result', () => {
    const { handlers, blocks } = setup();
    handlers.agents_group_start(
      {
        groupId: 'grp_1',
        agents: [{ index: 0, label: 'Explore HTTP' }],
      },
      'agents_group_start',
    );

    handlers.agent_progress(
      {
        groupId: 'grp_1',
        agentIndex: 0,
        label: 'Explore HTTP',
        event: 'partial',
        status: 'partial',
        summary: 'Mapped the routes before the explicit time budget ended.',
      },
      'agent_progress',
    );

    expect(group(blocks).agents[0]).toMatchObject({
      status: 'partial',
      summary: 'Mapped the routes before the explicit time budget ended.',
    });
  });

  it('upserts a re-emitted group by groupId (resume) and preserves non-resumed agent data', () => {
    const { handlers, blocks } = setup();
    handlers.agents_group_start(
      { groupId: 'grp_1', agents: [{ index: 0, label: 'auth' }, { index: 1, label: 'db' }] },
      'agents_group_start',
    );
    // agent 0 completes with a summary; agent 1 fails. (toolCallCount is set by
    // tool_call/heartbeat events, not the completed event — mirror real flow.)
    handlers.agent_progress({ groupId: 'grp_1', agentIndex: 0, label: 'auth', event: 'heartbeat', status: 'running', toolCallCount: 7 }, 'agent_progress');
    handlers.agent_progress({ groupId: 'grp_1', agentIndex: 0, label: 'auth', event: 'completed', summary: 'JWT ok', usage: { input_tokens: 5, output_tokens: 2 } }, 'agent_progress');
    handlers.agent_progress({ groupId: 'grp_1', agentIndex: 1, label: 'db', event: 'error', error: 'boom' }, 'agent_progress');
    handlers.agents_group_end({ groupId: 'grp_1', totalUsage: { input_tokens: 5, output_tokens: 2 } }, 'agents_group_end');
    // Resume re-emits the group: agent 1 back to pending (attempt 2), agent 0 unchanged.
    handlers.agents_group_start(
      { groupId: 'grp_1', resumed: true, agents: [
        { index: 0, label: 'auth', status: 'completed' },
        { index: 1, label: 'db', status: 'pending', attempt: 2 },
      ] },
      'agents_group_start',
    );
    const agentBlocks = blocks.filter((b) => b.type === 'agents');
    expect(agentBlocks).toHaveLength(1); // merged, not duplicated
    expect(group(blocks).status).toBe('running');
    // Non-resumed agent 0 keeps its summary + tool count (not blanked).
    expect(group(blocks).agents[0]).toMatchObject({ status: 'completed', summary: 'JWT ok', toolCallCount: 7 });
    // Resumed agent 1 flips to pending with the retry attempt.
    expect(group(blocks).agents[1]).toMatchObject({ status: 'pending', attempt: 2 });
  });

  it('marks a background group and threads the jobId', () => {
    const { handlers, blocks } = setup();
    handlers.agents_group_start(
      { groupId: 'grp_bg', background: true, jobId: 'job-abc', agents: [{ index: 0, label: 'scout' }] },
      'agents_group_start',
    );
    expect(group(blocks).background).toBe(true);
    expect(group(blocks).jobId).toBe('job-abc');
  });
});
