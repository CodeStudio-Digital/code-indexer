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
import type { ProfileLimitOverride } from '@mcp/code-agent/tools/subagent-provider.js';
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

const SPAWN_LIMIT_DEFAULTS: Record<MicroAgentCapability, Required<SubagentLimits>> = {
  explore: {
    // `maxToolCalls` is a budget of tool *CALLS* (invocations), NOT the number
    // of tools available (the env name is kept for back-compat). These flat
    // values are the safety-net floor when no research policy is present;
    // research-profiled agents derive 2x their depth soft target instead
    // (see derivedSpawnDefaults). Explicit 0 (admin/env) = unlimited.
    maxToolCalls: 80,
    timeoutMs: 840_000,
    stallMs: 90_000,
  },
  implement: {
    maxToolCalls: 150,
    timeoutMs: 1_800_000,
    stallMs: 120_000,
  },
  verify: {
    maxToolCalls: 80,
    timeoutMs: 900_000,
    stallMs: 120_000,
  },
  review: {
    maxToolCalls: 80,
    timeoutMs: 840_000,
    stallMs: 120_000,
  },
  full: {
    maxToolCalls: 150,
    timeoutMs: 1_800_000,
    stallMs: 120_000,
  },
};

/**
 * Default hard caps for one agent. With a research policy the hard cap is 2x
 * the depth soft target (quick 32 calls/6min ... exhaustive 320/50min) so the
 * synthesis nudge always fires well before the cutoff. A soft target the
 * caller explicitly disabled (0) does NOT disable the hard cap — that axis
 * falls back to the flat profile default; only an admin/env explicit 0 means
 * unlimited.
 */
function derivedSpawnDefaults(agent: NormalizedAgent): { maxToolCalls: number; timeoutMs: number } {
  const flat = SPAWN_LIMIT_DEFAULTS[agent.type];
  const policy = agent.researchPolicy;
  if (!policy) return { maxToolCalls: flat.maxToolCalls, timeoutMs: flat.timeoutMs };
  return {
    maxToolCalls: policy.softToolTarget > 0 ? policy.softToolTarget * 2 : flat.maxToolCalls,
    timeoutMs: policy.softTimeTargetMs > 0 ? policy.softTimeTargetMs * 2 : flat.timeoutMs,
  };
}

export interface SpawnLimitDeps {
  /** Admin per-profile hard-cap overrides (DB); wins over product defaults. */
  resolveLimitsForProfile?: (profileId?: string) => ProfileLimitOverride | undefined;
}

export function limitsForAgent(agent: NormalizedAgent, deps?: SpawnLimitDeps): SubagentLimits {
  const defaults = SPAWN_LIMIT_DEFAULTS[agent.type];
  const derived = derivedSpawnDefaults(agent);
  const override = deps?.resolveLimitsForProfile?.(agent.profile.id);
  // Layers per axis: DB per-profile override > depth-derived/flat default.
  // Zero is a first-class value (explicit unlimited); null/unset falls through.
  return {
    maxToolCalls: override?.maxToolCalls ?? derived.maxToolCalls,
    timeoutMs: override?.timeoutMs ?? derived.timeoutMs,
    stallMs: defaults.stallMs,
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
  limits?: SubagentLimits,
): SpawnRetentionAgent {
  return {
    index,
    label: agent.label,
    task: agent.task,
    profileId: agent.profile.id,
    files: agent.files,
    researchPolicy: agent.researchPolicy,
    maxTurns: agent.maxTurns,
    // Retain the ACTUAL dispatched caps so resume replays them instead of
    // re-resolving from env-only state.
    limits: limits ?? limitsForAgent(agent),
    reason: result.reason,
    usage: result.usage,
    toolCallCount: result.toolCallCount ?? 0,
    transcript: result.transcript,
    finalText: result.finalText,
    failureDetail: result.failureDetail,
  };
}
