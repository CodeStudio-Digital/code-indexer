/**
 * spawn-agent-core — shared shapes/helpers for the spawn_agent family
 * (blocking dispatch in spawn-agent.ts, background dispatch in
 * spawn-agent-background.ts). Extracted so the two dispatchers reuse the
 * normalized agent shape, per-profile limits, workspace briefing, and resume
 * retention mapping WITHOUT importing each other (no cycle).
 */
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { StopReason } from '@mcp/code-agent/core/runner.js';
import type {
  MicroAgentCapability,
  MicroAgentProfile,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';
import type { SubagentLimits } from '@mcp/code-agent/tools/implement-subagent.js';
import type { SpawnRetentionAgent } from '@mcp/code-agent/tools/spawn-agent-resume.js';
import { buildGlobalWorkspaceBriefing } from '@mcp/code-agent/core/global-workspace-context.js';
import {
  appendResearchContract,
  applyParentGoalBudget,
  type SubagentResearchPolicy,
} from '@mcp/code-agent/tools/subagent-research-policy.js';

export interface NormalizedAgent {
  task: string;
  type: MicroAgentCapability;
  profile: MicroAgentProfile;
  label: string;
  maxTurns: number;
  files?: string[];
  /** Present for read-only investigation/review profiles only. */
  researchPolicy?: SubagentResearchPolicy;
}

function envBudget(name: string, fallback: number, allowZero = false): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  const value = Math.floor(parsed);
  if (allowZero ? value < 0 : value <= 0) return fallback;
  return value;
}

const SPAWN_LIMIT_DEFAULTS: Record<MicroAgentCapability, Required<SubagentLimits>> = {
  explore: {
    // `maxToolCalls` is a budget of tool *CALLS* (invocations), NOT the number
    // of tools available (the env name is kept for back-compat). Default 0 =
    // unlimited: explore is read-only, so we let it run until it concludes or
    // trips a real liveness guard.
    maxToolCalls: 0,
    timeoutMs: 0,
    stallMs: 90_000,
  },
  implement: {
    maxToolCalls: 0,
    timeoutMs: 0,
    stallMs: 120_000,
  },
  verify: {
    maxToolCalls: 0,
    timeoutMs: 0,
    stallMs: 120_000,
  },
  review: {
    maxToolCalls: 0,
    timeoutMs: 0,
    stallMs: 120_000,
  },
  full: {
    maxToolCalls: 0,
    timeoutMs: 0,
    stallMs: 120_000,
  },
};

export function limitsForAgent(agent: NormalizedAgent): SubagentLimits {
  const defaults = SPAWN_LIMIT_DEFAULTS[agent.type];
  const prefix = `CODER_SPAWN_${agent.type.toUpperCase()}`;
  // Resolve on every dispatch so admin changes hot-apply without restarting
  // the worker. Zero is a first-class value for the optional hard caps.
  return {
    maxToolCalls: envBudget(`${prefix}_MAX_TOOLS`, defaults.maxToolCalls, true),
    timeoutMs: envBudget(`${prefix}_TIMEOUT_MS`, defaults.timeoutMs, true),
    stallMs: envBudget(`${prefix}_STALL_MS`, defaults.stallMs),
  };
}

export function buildSubagentWorkspaceBriefing(ctx: ToolContext): string {
  return buildGlobalWorkspaceBriefing(ctx);
}

export function taskWithWorkspaceBriefing(task: string, ctx: ToolContext): string {
  const briefing = buildSubagentWorkspaceBriefing(ctx);
  return briefing ? `${briefing}\n\n# Delegated task\n${task}` : task;
}

/** Resolve live parent-goal budget immediately before dispatch (hot apply). */
export function prepareAgentsForDispatch(
  agents: readonly NormalizedAgent[],
  ctx: ToolContext,
): NormalizedAgent[] {
  const goal = ctx.getGoalState?.();
  const budget = goal?.status === 'in_progress' && goal.budgetTokens && goal.budgetTokens > 0
    ? goal.budgetTokens
    : undefined;
  return agents.map((agent) => agent.researchPolicy
    ? {
        ...agent,
        researchPolicy: applyParentGoalBudget(agent.researchPolicy, budget, agents.length),
      }
    : agent);
}

export function systemPromptForAgent(agent: NormalizedAgent): string {
  return appendResearchContract(agent.profile.systemPrompt, agent.researchPolicy);
}

/** Map a NormalizedAgent + its run result into a resume-registry entry. */
export function toRetentionAgent(
  index: number,
  agent: NormalizedAgent,
  result: {
    reason: StopReason;
    usage: ChatUsage;
    finalText: string;
    transcript?: AgentMessage[];
    failureDetail?: string;
    toolCallCount?: number;
  },
): SpawnRetentionAgent {
  return {
    index,
    label: agent.label,
    task: agent.task,
    profileId: agent.profile.id,
    files: agent.files,
    researchPolicy: agent.researchPolicy,
    maxTurns: agent.maxTurns,
    limits: limitsForAgent(agent),
    reason: result.reason,
    usage: result.usage,
    toolCallCount: result.toolCallCount ?? 0,
    transcript: result.transcript,
    finalText: result.finalText,
    failureDetail: result.failureDetail,
  };
}
