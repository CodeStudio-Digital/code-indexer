/**
 * spawn-agent-background — fire-and-forget dispatch for
 * `spawn_agent({background:true})`. Registers a job, launches the parallel
 * worker pool WITHOUT awaiting, and returns a tool_result immediately so the
 * parent keeps working. The job settles on its own; `collect_agents` (or a
 * completion notice, Phase 4) delivers the result later.
 *
 * The job runs on a DETACHED ToolContext: its OWN abort signal (never the run
 * signal — run shutdown must not kill it) and a non-interactive permission
 * gate (no runner/SSE to resolve a prompt between runs → auto-deny).
 */
import { randomUUID } from 'node:crypto';
import { ok, err, type ToolResult, type ToolContext } from '@mcp/code-agent/core/tool.js';
import {
  runParallelAgents,
  classifySubagentTerminal,
  countSubagentOutcomes,
  type ParallelAgentSpec,
} from '@mcp/code-agent/tools/implement-subagent.js';
import { MICRO_AGENT_PROFILES } from '@mcp/code-agent/tools/micro-agent-profiles.js';
import { describeProvider, type SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import { providerForProfile, effortForProfile } from '@mcp/code-agent/tools/subagent-provider.js';
import {
  type NormalizedAgent,
  limitsForAgent,
  taskWithWorkspaceBriefing,
  toRetentionAgent,
  systemPromptForAgent,
} from '@mcp/code-agent/tools/spawn-agent-core.js';
import {
  renderParallelHeader,
  renderParallelBody,
  renderResumeHint,
} from '@mcp/code-agent/tools/spawn-agent-render.js';
import { captureInvestigation } from '@mcp/code-agent/tools/investigation-capture.js';
import { retainSpawnGroup } from '@mcp/code-agent/tools/spawn-agent-resume.js';
import {
  getSubagentJobManager,
  type BackgroundAgentSlot,
  type SubagentJob,
} from '@mcp/code-agent/tools/subagent-jobs.js';
import type { SessionId } from '@mcp/session-storage';

export async function runBackgroundEphemeral(
  deps: SubagentDeps,
  agents: NormalizedAgent[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const sessionId = ctx.runner?.sessionId;
  if (sessionId == null) {
    return err('spawn_agent: background:true needs an active session. Run without background for a one-shot.');
  }
  // Resolve each agent's provider from its profile (memoized in the resolver);
  // a batch can mix profiles, so `info` is a representative label for the
  // group-level slots/events while each spec carries its own provider.
  const agentProviders = await Promise.all(agents.map((a) => providerForProfile(deps, a.profile)));
  const agentInfos = agentProviders.map((p) => describeProvider(p));
  // Same resolved caps feed the dispatch specs, live events, and retention.
  const agentLimits = agents.map((a) => limitsForAgent(a, deps));
  const distinctLabels = [...new Set(agentInfos.map((i) => i.label))];
  const info = distinctLabels.length <= 1
    ? (agentInfos[0] ?? describeProvider(deps.provider))
    : { provider: 'mixed', model: distinctLabels.join(', '), label: distinctLabels.join(', ') };
  const jobId = `job-${randomUUID().slice(0, 8)}`;
  const groupId = randomUUID().slice(0, 8);
  const toolUseId = ctx.currentToolUseId;
  const manager = getSubagentJobManager();

  const slots: BackgroundAgentSlot[] = agents.map((a, i) => ({
    index: i, label: a.label, profileId: a.profile.id, task: a.task,
    status: 'pending', toolCallCount: 0,
    researchDepth: a.researchPolicy?.depth,
    softToolTarget: a.researchPolicy?.softToolTarget,
    softTimeTargetMs: a.researchPolicy?.softTimeTargetMs,
  }));
  const created = manager.create({ sessionId, jobId, groupId, provider: info.provider, model: info.model, agents: slots });
  if ('error' in created) return err(`spawn_agent: ${created.error}`);
  const job = created;

  ctx.runner?.emit('agents_group_start', {
    groupId, toolUseId, jobId, background: true, provider: info.provider, model: info.model,
    agents: agents.map((a, i) => ({
      index: i,
      label: a.label,
      provider: agentInfos[i]?.provider,
      model: agentInfos[i]?.model,
      task: a.task,
      status: 'pending' as const,
      researchDepth: a.researchPolicy?.depth,
      softToolTarget: a.researchPolicy?.softToolTarget,
      softTimeTargetMs: a.researchPolicy?.softTimeTargetMs,
      maxToolCalls: agentLimits[i]?.maxToolCalls,
      hardTimeoutMs: agentLimits[i]?.timeoutMs,
    })),
  });

  // Detached context: job-owned signal + non-interactive gate.
  const jobCtx: ToolContext = {
    ...ctx,
    signal: job.abort.signal,
    permissionGate: ctx.permissionGate?.forBackground(),
  };
  const specs: ParallelAgentSpec[] = agents.map((a, i) => ({
    task: taskWithWorkspaceBriefing(a.task, ctx),
    label: a.label,
    maxTurns: a.maxTurns,
    profile: a.profile.id,
    provider: agentProviders[i],
    reasoningEffort: effortForProfile(deps, a.profile),
    spawnId: groupId,
    systemPrompt: systemPromptForAgent(a),
    researchPolicy: a.researchPolicy,
    allowlist: a.profile.allowlist,
    pathScope: a.profile.pathScopeMode === 'enforce-writes' && a.files?.length ? a.files : undefined,
    pathScopeMode: a.profile.pathScopeMode,
    limits: agentLimits[i],
    waitMode: 'background',
  }));

  // Fire-and-forget — do NOT await.
  void runBackgroundJob(deps, jobCtx, ctx, agents, specs, job, info, sessionId);

  const labels = agents.map((a) => a.label).join(', ');
  return {
    ...ok(
      `[spawn_agent background] job=${jobId} group=${groupId} agents=${agents.length} (${labels}) started.\n` +
      `Results are NOT available yet — you'll get a <system-reminder> when the job finishes.\n` +
      `To wait for / fetch results now: collect_agents({job_id:"${jobId}"}).\n` +
      `Keep working on other tasks meanwhile. Do NOT re-spawn these tasks.`,
    ),
    structuredData: {
      kind: 'spawn_agent_background_result',
      status: 'running',
      jobId,
      spawnId: groupId,
      agentCount: agents.length,
    },
  };
}

async function runBackgroundJob(
  deps: SubagentDeps,
  jobCtx: ToolContext,
  ctx: ToolContext,
  agents: NormalizedAgent[],
  specs: ParallelAgentSpec[],
  job: SubagentJob,
  info: { provider: string; model: string },
  sessionId: SessionId,
): Promise<void> {
  const manager = getSubagentJobManager();
  try {
    const { results, totalUsage } = await runParallelAgents(
      {
        provider: deps.provider,
        tools: deps.parentTools,
        ctx: jobCtx,
        sessionId,
        sessionStore: deps.sessionStore,
        agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
      externalToolTiers: deps.externalToolTiers,
      maxParallel: deps.maxParallel,
      },
      specs,
      MICRO_AGENT_PROFILES.explore.systemPrompt,
      MICRO_AGENT_PROFILES.explore.allowlist,
      (progress) => {
        manager.patchAgent(job, progress.agentIndex, {
          status: progress.status, toolCallCount: progress.toolCallCount, phase: progress.phase,
          turn: progress.turn, elapsedMs: progress.elapsedMs, idleMs: progress.idleMs,
          deadlineMs: progress.deadlineMs, lastToolName: progress.lastToolName,
          summary: progress.summary,
        });
        const specProvider = specs[progress.agentIndex]?.provider;
        const pinfo = specProvider ? describeProvider(specProvider) : info;
        ctx.runner?.emit('agent_progress', {
          groupId: job.groupId,
          toolUseId: jobCtx.currentToolUseId,
          jobId: job.jobId,
          background: true,
          task: agents[progress.agentIndex]?.task,
          provider: pinfo.provider,
          model: pinfo.model,
          ...progress,
        });
      },
    );

    // Progress events are best-effort and may be dropped during worker
    // teardown. Reconcile every slot from the authoritative terminal results
    // before exposing the job to collect_agents.
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const terminal = classifySubagentTerminal(result.reason, result.finalText ?? '');
      manager.patchAgent(job, i, {
        status: terminal.status,
        result: result.workResult,
        toolCallCount: result.toolCallCount,
      });
    }

    // Build the real aggregated report FIRST (pure string assembly).
    const header = renderParallelHeader(results.length, info, totalUsage, job.groupId);
    const body = renderParallelBody(results.map((r, i) => ({
      label: r.label, type: agents[i].type, reason: r.reason, toolCallCount: r.toolCallCount,
      usage: r.usage, finalText: r.finalText, collected: r.collected,
      maxToolCalls: specs[i]?.limits?.maxToolCalls,
    })));
    const unfinished = results.filter((r) => r.reason !== 'completed').length;
    const hint = unfinished > 0 ? renderResumeHint(job.groupId, unfinished) : '';

    // Persistence side-effects are BEST-EFFORT: a background job outlives its
    // spawning run, so its bundle writer may be tearing down when it settles.
    // A throw here (read-only root, writer fencing) must NOT rewrite a
    // successful job into a "failed" one and discard the real findings.
    try {
      await deps.sessionStore?.bumpSessionUsage(
        sessionId,
        totalUsage,
        `background-job:${job.jobId}`,
      );
      job.usageAccounted = true;
    }
    catch (e) { console.warn(`[coder] background bumpSessionUsage failed: ${e instanceof Error ? e.message : String(e)}`); }
    try {
      for (let i = 0; i < results.length; i++) {
        await captureInvestigation(deps, ctx, agents[i], results[i].finalText ?? '', '', results[i].usage.input_tokens + results[i].usage.output_tokens);
      }
    } catch { /* captureInvestigation is itself guarded; belt-and-suspenders */ }
    let resumableCount = 0;
    try {
      resumableCount = await retainSpawnGroup({
        sessionId, spawnId: job.groupId, provider: info.provider, model: info.model,
        agents: results.map((r, i) => ({ ...toRetentionAgent(i, agents[i], r, specs[i]?.limits), toolCallCount: r.toolCallCount })),
        store: deps.sessionStore,
      });
    } catch (e) { console.warn(`[coder] background retainSpawnGroup failed: ${e instanceof Error ? e.message : String(e)}`); }
    job.resumableCount = resumableCount;

    const outcomeCounts = countSubagentOutcomes(results);
    try {
      ctx.runner?.emit('agents_group_end', {
        groupId: job.groupId, jobId: job.jobId, status: 'completed', totalUsage,
        agentCount: results.length, successCount: outcomeCounts.completedCount,
        ...outcomeCounts, resumableCount,
      });
    } catch { /* emit is best-effort */ }
    manager.settle(job, header + body + hint, totalUsage, 'done');
  } catch (e) {
    const aborted = job.abort.signal.aborted;
    const failureText = e instanceof Error ? e.message : String(e);
    for (const slot of job.agents) {
      manager.patchAgent(job, slot.index, {
        status: aborted ? 'aborted' : 'error',
        summary: failureText.slice(0, 200),
      });
    }
    job.resumableCount = 0;
    const usage = { input_tokens: 0, output_tokens: 0 };
    ctx.runner?.emit('agents_group_end', {
      groupId: job.groupId, jobId: job.jobId, status: aborted ? 'aborted' : 'completed',
      totalUsage: usage, agentCount: job.agents.length, successCount: 0,
      completedCount: 0, partialCount: 0, failedCount: job.agents.length, resumableCount: 0,
    });
    manager.settle(
      job,
      `[background job ${job.jobId} ${aborted ? 'aborted' : 'failed'}: ${failureText}]`,
      usage,
      aborted ? 'aborted' : 'done',
    );
  }
}
