import type { AgentStatus, AgentsGroup, ParallelAgent, StreamBlock, Usage } from './types.js';

export interface AgentProgressPayload {
  groupId: string;
  agentIndex: number;
  label: string;
  event: 'spawned' | 'heartbeat' | 'tool_call' | 'completed' | 'partial' | 'error' | 'timed_out' | 'aborted';
  status?: AgentStatus;
  provider?: string;
  model?: string;
  toolCallCount?: number;
  note?: string;
  phase?: string;
  turn?: number;
  elapsedMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  lastToolName?: string;
  attempt?: number;
  usage?: Usage;
  summary?: string;
  error?: string;
}

export function applyAgentProgress(blocks: StreamBlock[], d: AgentProgressPayload): boolean {
  const blockIndex = blocks.findIndex((b) => b.type === 'agents' && b.group.groupId === d.groupId);
  if (blockIndex < 0) return false;
  const block = blocks[blockIndex];
  if (block.type !== 'agents') return false;
  const agent = block.group.agents[d.agentIndex];
  if (!agent) return false;
  const nextAgent = patchAgent(agent, d);
  const nextAgents = block.group.agents.map((a, i) => (i === d.agentIndex ? nextAgent : a));
  blocks[blockIndex] = {
    type: 'agents',
    group: {
      ...block.group,
      agents: nextAgents,
    },
  };
  return true;
}

export function applyAgentsGroupEnd(
  blocks: StreamBlock[],
  d: { groupId: string; totalUsage?: Usage },
): boolean {
  const blockIndex = blocks.findIndex((b) => b.type === 'agents' && b.group.groupId === d.groupId);
  if (blockIndex < 0) return false;
  const block = blocks[blockIndex];
  if (block.type !== 'agents') return false;
  blocks[blockIndex] = {
    type: 'agents',
    group: {
      ...block.group,
      status: 'completed',
      totalUsage: d.totalUsage,
    } satisfies AgentsGroup,
  };
  return true;
}

function patchAgent(agent: ParallelAgent, d: AgentProgressPayload): ParallelAgent {
  const base: ParallelAgent = {
    ...agent,
    ...(d.provider ? { provider: d.provider } : {}),
    ...(d.model ? { model: d.model } : {}),
    ...(d.note ? { progressNote: d.note } : {}),
    ...(d.phase ? { phase: d.phase } : {}),
    ...(d.turn != null ? { turn: d.turn } : {}),
    ...(d.elapsedMs != null ? { elapsedMs: d.elapsedMs } : {}),
    ...(d.idleMs != null ? { idleMs: d.idleMs } : {}),
    ...(d.deadlineMs != null ? { deadlineMs: d.deadlineMs } : {}),
    ...(d.lastToolName ? { lastToolName: d.lastToolName } : {}),
    ...(d.attempt != null ? { attempt: d.attempt } : {}),
  };

  switch (d.event) {
    case 'spawned':
      return { ...base, status: d.status ?? 'running' };
    case 'heartbeat':
      return {
        ...base,
        status: d.status ?? 'running',
        ...(d.toolCallCount != null ? { toolCallCount: d.toolCallCount } : {}),
      };
    case 'tool_call':
      return {
        ...base,
        status: d.status ?? 'running',
        toolCallCount: d.toolCallCount ?? base.toolCallCount + 1,
      };
    case 'completed':
      return { ...base, status: 'completed', usage: d.usage, summary: d.summary };
    case 'partial':
      return { ...base, status: 'partial', usage: d.usage, summary: d.summary };
    case 'timed_out':
      return { ...base, status: 'timed_out', error: d.error, summary: d.summary };
    case 'aborted':
      return { ...base, status: 'aborted', error: d.error, summary: d.summary };
    case 'error':
      return { ...base, status: 'error', error: d.error };
  }
}
