/**
 * resume-run — relaunch mechanics for resume_agent. Rebuilds ParallelAgentSpecs
 * from retained state (transcript + continuation nudge), re-emits the SAME
 * groupId so UI rows flip back to running with an attempt bump, runs the
 * existing parallel worker pool, then updates the registry + investigation
 * ledger. Kept separate from the tool schema/validation to respect LOC caps.
 */
import type { AgentMessage, ChatUsage } from '@mcp/code-agent/core/messages.js';
import type { StopReason } from '@mcp/code-agent/core/runner.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import {
  runParallelAgents,
  countSubagentOutcomes,
  isPartialSubagentReason,
  type ParallelAgentSpec,
} from '@mcp/code-agent/tools/implement-subagent.js';
import {
  MICRO_AGENT_PROFILES,
  resolveMicroAgentProfile,
  type MicroAgentProfile,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';
import { describeProvider, type SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import { providerForProfile, effortForProfile } from '@mcp/code-agent/tools/subagent-provider.js';
import {
  renderParallelHeader,
  renderParallelBody,
  renderResumeHint,
  renderTrail,
} from '@mcp/code-agent/tools/spawn-agent-render.js';
import { captureInvestigation } from '@mcp/code-agent/tools/investigation-capture.js';
import { buildContinuationNudge } from '@mcp/code-agent/tools/resume-nudges.js';
import {
  replaceAgentState,
  type ResumableAgentState,
  type ResumableGroup,
} from '@mcp/code-agent/tools/subagent-resume-registry.js';

function reasonToStatus(reason: StopReason): 'completed' | 'partial' | 'aborted' | 'error' {
  if (reason === 'completed') return 'completed';
  if (isPartialSubagentReason(reason)) return 'partial';
  if (reason === 'aborted') return 'aborted';
  return 'error';
}

function profileFor(state: ResumableAgentState): MicroAgentProfile {
  return resolveMicroAgentProfile(state.profileId) ?? MICRO_AGENT_PROFILES.explore;
}

function specFor(state: ResumableAgentState, profile: MicroAgentProfile, guidance?: string): ParallelAgentSpec {
  const nudge = buildContinuationNudge({
    attempt: state.attempt + 1,
    reason: state.reason,
    failureNote: state.failureNote,
    toolCallCount: state.toolCallCount,
    maxToolCalls: state.limits.maxToolCalls,
    guidance,
    isImplement: profile.capability === 'implement',
  });
  const initialMessages: AgentMessage[] = [
    ...(state.transcript ?? []),
    { role: 'user', content: [{ type: 'text', text: nudge }] },
  ];
  return {
    task: state.task,
    label: state.label,
    maxTurns: state.maxTurns,
    systemPrompt: profile.systemPrompt,
    allowlist: profile.allowlist,
    pathScope: profile.pathScopeMode === 'enforce-writes' && state.files?.length ? state.files : undefined,
    pathScopeMode: profile.pathScopeMode,
    limits: state.limits,
    initialMessages,
  };
}

export async function relaunchResumedAgents(
  deps: SubagentDeps,
  ctx: ToolContext,
  group: ResumableGroup,
  targets: ResumableAgentState[],
  guidance: string | undefined,
): Promise<{ text: string; usage: ChatUsage; stillFailed: number }> {
  const sessionId = group.sessionId;
  const profiles = targets.map(profileFor);
  const targetIdx = new Set(targets.map((t) => t.agentIndex));
  // Per-target provider resolved from each retained agent's profile (memoized).
  const targetProviders = await Promise.all(profiles.map((p) => providerForProfile(deps, p)));
  const agentInfos = targetProviders.map((p) => describeProvider(p));
  const providerByIndex = new Map<number, { provider: string; model: string }>();
  targets.forEach((t, i) => providerByIndex.set(t.agentIndex, agentInfos[i]));
  const distinctLabels = [...new Set(agentInfos.map((i) => i.label))];
  const info = distinctLabels.length <= 1
    ? (agentInfos[0] ?? describeProvider(deps.provider))
    : { provider: 'mixed', model: distinctLabels.join(', '), label: distinctLabels.join(', ') };

  ctx.runner?.emit('agents_group_start', {
    groupId: group.spawnId,
    provider: info.provider,
    model: info.model,
    resumed: true,
    agents: group.agents.map((a) => {
      const pinfo = providerByIndex.get(a.agentIndex) ?? info;
      return {
        index: a.agentIndex,
        label: a.label,
        provider: pinfo.provider,
        model: pinfo.model,
        task: a.task,
        status: targetIdx.has(a.agentIndex) ? 'pending' : reasonToStatus(a.reason),
        attempt: targetIdx.has(a.agentIndex) ? a.attempt + 1 : a.attempt,
      };
    }),
  });

  const specs = targets.map((state, i) => ({
    ...specFor(state, profiles[i], guidance),
    provider: targetProviders[i],
    reasoningEffort: effortForProfile(deps, profiles[i]),
  }));
  const { results, totalUsage } = await runParallelAgents(
    { provider: deps.provider, tools: deps.parentTools, ctx, sessionId, agentLoopV2: ctx.runner?.agentLoopV2 ?? false },
    specs,
    MICRO_AGENT_PROFILES.explore.systemPrompt,
    MICRO_AGENT_PROFILES.explore.allowlist,
    (progress) => {
      const original = targets[progress.agentIndex];
      const pinfo = agentInfos[progress.agentIndex] ?? info;
      ctx.runner?.emit('agent_progress', {
        groupId: group.spawnId,
        provider: pinfo.provider,
        model: pinfo.model,
        ...progress,
        agentIndex: original ? original.agentIndex : progress.agentIndex,
        attempt: original ? original.attempt + 1 : undefined,
      });
    },
  );

  const renderables = results.map((r, i) => {
    const state = targets[i];
    const profile = profiles[i];
    const attempt = state.attempt + 1;
    if (sessionId != null) {
      // If the relaunch failed AGAIN but produced no fresh transcript (a throw
      // before/around runSubagent → outer-catch result has transcript=undefined),
      // KEEP the prior transcript so resume state isn't cannibalized (the agent
      // could still retry). A completed resume legitimately clears it.
      const nextTranscript = r.reason === 'completed' ? undefined : (r.transcript ?? state.transcript);
      replaceAgentState(sessionId, group.spawnId, {
        ...state,
        reason: r.reason,
        failureNote: r.reason !== 'completed' ? (r.failureDetail || r.finalText).slice(0, 500) : undefined,
        transcript: nextTranscript,
        toolCallCount: r.toolCallCount,
        usage: r.usage,
        attempt,
        capturedAt: Date.now(),
        approxBytes: 0,
      });
    }
    if (r.reason === 'completed') {
      captureInvestigation(
        deps, ctx,
        { task: state.task, label: state.label, type: profile.capability },
        r.finalText ?? '', renderTrail(r.collected), r.usage.input_tokens + r.usage.output_tokens,
      );
    }
    return {
      label: state.label,
      type: profile.capability,
      reason: r.reason,
      toolCallCount: r.toolCallCount,
      usage: r.usage,
      finalText: r.finalText,
      collected: r.collected,
      attempt,
      // Number by ORIGINAL roster index so a partial relaunch doesn't renumber
      // (else the model's next resume_agent({agents:[N]}) targets the wrong one).
      displayIndex: state.agentIndex,
    };
  });

  const outcomeCounts = countSubagentOutcomes(results);
  ctx.runner?.emit('agents_group_end', {
    groupId: group.spawnId,
    totalUsage,
    agentCount: results.length,
    successCount: outcomeCounts.completedCount,
    ...outcomeCounts,
    resumableCount: results.filter((r) => r.reason !== 'completed' && (r.transcript?.length ?? 0) > 0).length,
  });

  const stillFailed = results.filter((r) => r.reason !== 'completed').length;
  const header = `[resume group=${group.spawnId}: ${targets.length} agent(s) relaunched]\n\n`
    + renderParallelHeader(results.length, info, totalUsage, group.spawnId);
  const body = renderParallelBody(renderables);
  const hint = stillFailed > 0 ? renderResumeHint(group.spawnId, stillFailed) : '';
  return { text: header + body + hint, usage: totalUsage, stillFailed };
}
