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

export interface NormalizedAgent {
  task: string;
  type: MicroAgentCapability;
  profile: MicroAgentProfile;
  label: string;
  maxTurns: number;
  files?: string[];
}

function envBudget(name: string, fallback: number, allowZero = false): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  const value = Math.floor(parsed);
  if (allowZero ? value < 0 : value <= 0) return fallback;
  return value;
}

export const SPAWN_LIMITS: Record<MicroAgentCapability, Required<SubagentLimits>> = {
  explore: {
    // `maxToolCalls` is a budget of tool *CALLS* (invocations), NOT the number
    // of tools available (the env name is kept for back-compat). Default 0 =
    // unlimited: explore is read-only, so we let it run until it concludes or
    // trips the time/turn/stall guards below.
    maxToolCalls: envBudget('CODER_SPAWN_EXPLORE_MAX_TOOLS', 0, true),
    timeoutMs: envBudget('CODER_SPAWN_EXPLORE_TIMEOUT_MS', 10 * 60_000),
    stallMs: envBudget('CODER_SPAWN_EXPLORE_STALL_MS', 90_000),
  },
  implement: {
    maxToolCalls: envBudget('CODER_SPAWN_IMPLEMENT_MAX_TOOLS', 80, true),
    timeoutMs: envBudget('CODER_SPAWN_IMPLEMENT_TIMEOUT_MS', 20 * 60_000),
    stallMs: envBudget('CODER_SPAWN_IMPLEMENT_STALL_MS', 120_000),
  },
  verify: {
    maxToolCalls: envBudget('CODER_SPAWN_VERIFY_MAX_TOOLS', 40, true),
    timeoutMs: envBudget('CODER_SPAWN_VERIFY_TIMEOUT_MS', 15 * 60_000),
    stallMs: envBudget('CODER_SPAWN_VERIFY_STALL_MS', 120_000),
  },
  review: {
    maxToolCalls: envBudget('CODER_SPAWN_REVIEW_MAX_TOOLS', 40, true),
    timeoutMs: envBudget('CODER_SPAWN_REVIEW_TIMEOUT_MS', 15 * 60_000),
    stallMs: envBudget('CODER_SPAWN_REVIEW_STALL_MS', 120_000),
  },
  full: {
    maxToolCalls: envBudget('CODER_SPAWN_FULL_MAX_TOOLS', 80, true),
    timeoutMs: envBudget('CODER_SPAWN_FULL_TIMEOUT_MS', 20 * 60_000),
    stallMs: envBudget('CODER_SPAWN_FULL_STALL_MS', 120_000),
  },
};

export function limitsForAgent(agent: NormalizedAgent): SubagentLimits {
  return SPAWN_LIMITS[agent.type];
}

export function buildSubagentWorkspaceBriefing(ctx: ToolContext): string {
  return buildGlobalWorkspaceBriefing(ctx);
}

export function taskWithWorkspaceBriefing(task: string, ctx: ToolContext): string {
  const briefing = buildSubagentWorkspaceBriefing(ctx);
  return briefing ? `${briefing}\n\n# Delegated task\n${task}` : task;
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
