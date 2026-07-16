/**
 * spawn-agent-resume — glue between spawn_agent's result loop and the
 * in-memory resume registry. Maps finished agents to `ResumableAgentState`
 * and retains the group so `resume_agent` can relaunch failed agents with
 * their transcript intact.
 *
 * Kept out of spawn-agent.ts to respect its LOC budget and so the async
 * (background) path can retain groups through the same door.
 */
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { StopReason } from '@mcp/code-agent/core/runner.js';
import type { SubagentLimits } from '@mcp/code-agent/tools/implement-subagent.js';
import type { MicroAgentProfileId } from '@mcp/code-agent/tools/micro-agent-profiles.js';
import { retainGroup, type ResumableGroup } from '@mcp/code-agent/tools/subagent-resume-registry.js';

export interface SpawnRetentionAgent {
  index: number;
  label: string;
  task: string;
  profileId: MicroAgentProfileId;
  files?: string[];
  maxTurns: number;
  limits: SubagentLimits;
  reason: StopReason;
  usage: ChatUsage;
  toolCallCount: number;
  transcript?: AgentMessage[];
  finalText: string;
  /** Raw watchdog/error message — SubagentRunResult.failureDetail. */
  failureDetail?: string;
}

/** Count tool_use blocks in a transcript (single-agent path has no counter). */
export function countToolUses(transcript: AgentMessage[] | undefined): number {
  if (!transcript) return 0;
  let n = 0;
  for (const m of transcript) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) if (b.type === 'tool_use') n++;
  }
  return n;
}

/** How many agents did NOT complete — drives the resume-hint footer. */
export function countFailed(agents: Array<{ reason: StopReason }>): number {
  return agents.filter((a) => a.reason !== 'completed').length;
}

/**
 * Build + retain a resumable group from finished spawn results. Skipped when
 * there is no session (retention is session-scoped) or nothing failed (all
 * completed → nothing to resume, no memory spent).
 */
export function retainSpawnGroup(args: {
  sessionId: number | undefined;
  spawnId: string;
  provider: string;
  model: string;
  agents: SpawnRetentionAgent[];
}): number {
  if (args.sessionId == null) return 0;
  const resumableCount = args.agents.filter((a) => a.reason !== 'completed' && (a.transcript?.length ?? 0) > 0).length;
  if (countFailed(args.agents) === 0 && process.env.CODER_RESUME_RETAIN_COMPLETED !== '1') return 0;
  const now = Date.now();
  const group: ResumableGroup = {
    spawnId: args.spawnId,
    sessionId: args.sessionId,
    provider: args.provider,
    model: args.model,
    createdAt: now,
    lastTouchedAt: now,
    agents: args.agents.map((a) => ({
      agentIndex: a.index,
      label: a.label,
      task: a.task,
      profileId: a.profileId,
      files: a.files,
      maxTurns: a.maxTurns,
      limits: a.limits,
      transcript: a.transcript,
      reason: a.reason,
      failureNote: a.reason !== 'completed'
        ? (a.failureDetail || a.finalText).slice(0, 500)
        : undefined,
      toolCallCount: a.toolCallCount || countToolUses(a.transcript),
      usage: a.usage,
      attempt: 1,
      capturedAt: now,
      approxBytes: 0,
    })),
  };
  retainGroup(args.sessionId, group);
  return resumableCount;
}
