import type { AgentStatus, AgentsGroup, ParallelAgent, ResearchDepth, StreamBlock, Usage } from './types.js';

export interface AgentProgressPayload {
  groupId: string;
  toolUseId?: string;
  agentIndex: number;
  label: string;
  task?: string;
  background?: boolean;
  jobId?: string;
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
  researchDepth?: ResearchDepth;
  softToolTarget?: number;
  softTimeTargetMs?: number;
  /** Hard caps in effect for the run — emitted by the subagent monitor. */
  limit?: { maxToolCalls?: number; timeoutMs?: number; stallMs?: number };
}

export function applyAgentProgress(blocks: StreamBlock[], d: AgentProgressPayload): boolean {
  const blockIndex = blocks.findIndex((b) => b.type === 'agents' && b.group.groupId === d.groupId);
  // Reattach can begin after the bounded SSE buffer has already dropped the
  // original agents_group_start. A live heartbeat is enough to reconstruct a
  // minimal group; later progress events fill the remaining agents and the
  // normal agents_group_end event seals it. Without this recovery path the
  // process rail showed a live subagent while the Subagents panel stayed empty.
  if (blockIndex < 0) {
    const seed: ParallelAgent = {
      index: d.agentIndex,
      label: d.label,
      status: 'pending',
      toolCallCount: 0,
    };
    blocks.push({
      type: 'agents',
      group: {
        groupId: d.groupId,
        toolUseId: d.toolUseId,
        status: 'running',
        provider: d.provider,
        model: d.model,
        background: d.background,
        jobId: d.jobId,
        agents: [patchAgent(seed, d)],
      },
    });
    return true;
  }
  const block = blocks[blockIndex];
  if (block.type !== 'agents') return false;
  const agentPosition = block.group.agents.findIndex((agent) => agent.index === d.agentIndex);
  const seed: ParallelAgent = {
    index: d.agentIndex,
    label: d.label,
    status: 'pending',
    toolCallCount: 0,
  };
  const currentAgent = agentPosition >= 0 ? block.group.agents[agentPosition] : undefined;
  const nextAgent = patchAgent(currentAgent ?? seed, d);
  const nextAgents = agentPosition >= 0
    ? block.group.agents.map((agent, index) => (index === agentPosition ? nextAgent : agent))
    : [...block.group.agents, nextAgent].sort((a, b) => a.index - b.index);
  blocks[blockIndex] = {
    type: 'agents',
    group: {
      ...block.group,
      toolUseId: d.toolUseId ?? block.group.toolUseId,
      provider: d.provider ?? block.group.provider,
      model: d.model ?? block.group.model,
      background: d.background ?? block.group.background,
      jobId: d.jobId ?? block.group.jobId,
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
    ...(d.task ? { task: d.task } : {}),
    ...(d.note ? { progressNote: d.note } : {}),
    ...(d.phase ? { phase: d.phase } : {}),
    ...(d.turn != null ? { turn: d.turn } : {}),
    ...(d.elapsedMs != null ? { elapsedMs: d.elapsedMs } : {}),
    ...(d.idleMs != null ? { idleMs: d.idleMs } : {}),
    ...(d.deadlineMs != null ? { deadlineMs: d.deadlineMs } : {}),
    ...(d.lastToolName ? { lastToolName: d.lastToolName } : {}),
    ...(d.attempt != null ? { attempt: d.attempt } : {}),
    ...(d.researchDepth ? { researchDepth: d.researchDepth } : {}),
    ...(d.softToolTarget != null ? { softToolTarget: d.softToolTarget } : {}),
    ...(d.softTimeTargetMs != null ? { softTimeTargetMs: d.softTimeTargetMs } : {}),
    ...(d.limit?.maxToolCalls != null && d.limit.maxToolCalls > 0
      ? { maxToolCalls: d.limit.maxToolCalls }
      : {}),
    ...(agent.deadlineMs == null && d.deadlineMs == null
      && d.limit?.timeoutMs != null && d.limit.timeoutMs > 0
      ? { deadlineMs: d.limit.timeoutMs }
      : {}),
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
