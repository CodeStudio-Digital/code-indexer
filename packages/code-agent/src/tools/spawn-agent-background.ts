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
  type ParallelAgentSpec,
} from '@mcp/code-agent/tools/implement-subagent.js';
import { MICRO_AGENT_PROFILES } from '@mcp/code-agent/tools/micro-agent-profiles.js';
import { describeProvider, type SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import {
  type NormalizedAgent,
  limitsForAgent,
  taskWithWorkspaceBriefing,
  toRetentionAgent,
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

export async function runBackgroundEphemeral(
  deps: SubagentDeps,
  agents: NormalizedAgent[],
  ctx: ToolContext,
): Promise<ToolResult> {
  const sessionId = ctx.runner?.sessionId;
  if (sessionId == null) {
    return err('spawn_agent: background:true needs an active session. Run without background for a one-shot.');
  }
  const provider = deps.subagentProvider ?? deps.provider;
  const info = describeProvider(provider);
  const jobId = `job-${randomUUID().slice(0, 8)}`;
  const groupId = randomUUID().slice(0, 8);
  const manager = getSubagentJobManager();

  const slots: BackgroundAgentSlot[] = agents.map((a, i) => ({
    index: i, label: a.label, profileId: a.profile.id, task: a.task,
    status: 'pending', toolCallCount: 0,
  }));
  const created = manager.create({ sessionId, jobId, groupId, provider: info.provider, model: info.model, agents: slots });
  if ('error' in created) return err(`spawn_agent: ${created.error}`);
  const job = created;

  ctx.runner?.emit('agents_group_start', {
    groupId, jobId, background: true, provider: info.provider, model: info.model,
    agents: agents.map((a, i) => ({ index: i, label: a.label, provider: info.provider, model: info.model, task: a.task, status: 'pending' })),
  });

  // Detached context: job-owned signal + non-interactive gate.
  const jobCtx: ToolContext = {
    ...ctx,
    signal: job.abort.signal,
    permissionGate: ctx.permissionGate?.forBackground(),
  };
  const specs: ParallelAgentSpec[] = agents.map((a) => ({
    task: taskWithWorkspaceBriefing(a.task, ctx),
    label: a.label,
    maxTurns: a.maxTurns,
    systemPrompt: a.profile.systemPrompt,
    allowlist: a.profile.allowlist,
    pathScope: a.profile.pathScopeMode === 'enforce-writes' && a.files?.length ? a.files : undefined,
    pathScopeMode: a.profile.pathScopeMode,
    limits: limitsForAgent(a),
  }));

  // Fire-and-forget — do NOT await.
  void runBackgroundJob(deps, jobCtx, ctx, agents, specs, job, info, sessionId);

  const labels = agents.map((a) => a.label).join(', ');
  return ok(
    `[spawn_agent background] job=${jobId} group=${groupId} agents=${agents.length} (${labels}) started.\n` +
    `Results are NOT available yet — you'll get a <system-reminder> when the job finishes.\n` +
    `To wait for / fetch results now: collect_agents({job_id:"${jobId}"}).\n` +
    `Keep working on other tasks meanwhile. Do NOT re-spawn these tasks.`,
  );
}

async function runBackgroundJob(
  deps: SubagentDeps,
  jobCtx: ToolContext,
  ctx: ToolContext,
  agents: NormalizedAgent[],
  specs: ParallelAgentSpec[],
  job: SubagentJob,
  info: { provider: string; model: string },
  sessionId: number,
): Promise<void> {
  const manager = getSubagentJobManager();
  try {
    const { results, totalUsage } = await runParallelAgents(
      { provider: deps.subagentProvider ?? deps.provider, tools: deps.parentTools, ctx: jobCtx, sessionId, agentLoopV2: ctx.runner?.agentLoopV2 ?? false },
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
        ctx.runner?.emit('agent_progress', { groupId: job.groupId, provider: info.provider, model: info.model, ...progress });
      },
    );

    // Build the real aggregated report FIRST (pure string assembly).
    const header = renderParallelHeader(results.length, info, totalUsage, job.groupId);
    const body = renderParallelBody(results.map((r, i) => ({
      label: r.label, type: agents[i].type, reason: r.reason, toolCallCount: r.toolCallCount,
      usage: r.usage, finalText: r.finalText, collected: r.collected,
    })));
    const failed = results.filter((r) => r.reason !== 'completed').length;
    const hint = failed > 0 ? renderResumeHint(job.groupId, failed) : '';

    // Persistence side-effects are BEST-EFFORT: a background job outlives its
    // spawning run, so the worker/DB may be tearing down when it settles. A
    // throw here (SQLITE_BUSY, closed connection) must NOT rewrite a
    // successful job into a "failed" one and discard the real findings.
    try { deps.sessionStore?.bumpSessionUsage(sessionId, totalUsage); job.usageAccounted = true; }
    catch (e) { console.warn(`[coder] background bumpSessionUsage failed: ${e instanceof Error ? e.message : String(e)}`); }
    try {
      for (let i = 0; i < results.length; i++) {
        captureInvestigation(deps, ctx, agents[i], results[i].finalText ?? '', '', results[i].usage.input_tokens + results[i].usage.output_tokens);
      }
    } catch { /* captureInvestigation is itself guarded; belt-and-suspenders */ }
    try {
      retainSpawnGroup({
        sessionId, spawnId: job.groupId, provider: info.provider, model: info.model,
        agents: results.map((r, i) => ({ ...toRetentionAgent(i, agents[i], r), toolCallCount: r.toolCallCount })),
      });
    } catch (e) { console.warn(`[coder] background retainSpawnGroup failed: ${e instanceof Error ? e.message : String(e)}`); }

    try {
      ctx.runner?.emit('agents_group_end', {
        groupId: job.groupId, jobId: job.jobId, status: 'completed', totalUsage,
        agentCount: results.length, successCount: results.length - failed,
      });
    } catch { /* emit is best-effort */ }
    manager.settle(job, header + body + hint, totalUsage, 'done');
  } catch (e) {
    const aborted = job.abort.signal.aborted;
    const usage = { input_tokens: 0, output_tokens: 0 };
    ctx.runner?.emit('agents_group_end', {
      groupId: job.groupId, jobId: job.jobId, status: aborted ? 'aborted' : 'completed', totalUsage: usage, agentCount: job.agents.length, successCount: 0,
    });
    manager.settle(job, `[background job ${job.jobId} ${aborted ? 'aborted' : 'failed'}: ${e instanceof Error ? e.message : String(e)}]`, usage, aborted ? 'aborted' : 'done');
  }
}
