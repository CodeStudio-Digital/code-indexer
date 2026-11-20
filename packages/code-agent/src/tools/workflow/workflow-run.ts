/**
 * workflow-run — wave executor for the `workflow` tool. Dispatches pending
 * steps whose dependencies completed, one parallel wave at a time, on the
 * SAME engine as spawn_agent/execute_tasks: per-profile provider/effort/
 * limits, live agents_group_* events, resume retention and per-agent abort.
 * Dependency results are injected as bounded DIGESTS — never transcripts.
 */
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatUsage } from '@mcp/code-agent/core/messages.js';
import {
  runParallelAgents, countSubagentOutcomes, isPartialSubagentReason, type ParallelAgentSpec,
} from '@mcp/code-agent/tools/implement-subagent.js';
import { describeProvider, type SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import { providerForProfile, effortForProfile } from '@mcp/code-agent/tools/subagent-provider.js';
import { MICRO_AGENT_PROFILES } from '@mcp/code-agent/tools/micro-agent-profiles.js';
import { buildResearchPolicy } from '@mcp/code-agent/tools/subagent-research-policy.js';
import {
  limitsForAgent, systemPromptForAgent, taskWithWorkspaceBriefing, toRetentionAgent,
  type NormalizedAgent,
} from '@mcp/code-agent/tools/spawn-agent-core.js';
import { retainSpawnGroup } from '@mcp/code-agent/tools/spawn-agent-resume.js';
import { registerActiveAgent } from '@mcp/code-agent/tools/active-agent-registry.js';
import { emitSubagentEvent } from '../subagent-events.js';
import {
  assertWorkflowRunLease,
  saveWorkflow,
  startWorkflowRunLeaseKeepalive,
} from './workflow-registry.js';
import { workflowStatusFromSteps, type WorkflowRecord, type WorkflowStepState } from './workflow-types.js';
import { runReadyWorkflow } from './workflow-readiness.js';
import { workResult } from '../../runtime/work-result.js';
import { childChatId } from '@mcp/session-storage/collaboration/types.js';

const DEP_DIGEST_CHARS = 3_500;
const DEP_DIGEST_TOTAL_CHARS = 10_500;

function addUsage(acc: ChatUsage, usage: ChatUsage | undefined): void {
  acc.input_tokens += usage?.input_tokens ?? 0;
  acc.output_tokens += usage?.output_tokens ?? 0;
}

/** Bounded digest of completed prerequisite steps, appended to the step prompt. */
export function buildDependencyContext(record: WorkflowRecord, step: WorkflowStepState): string {
  const parts: string[] = [];
  let budget = DEP_DIGEST_TOTAL_CHARS;
  for (const depId of step.dependsOn) {
    const dep = record.steps.find((s) => s.id === depId);
    if (!dep?.summary || budget <= 0) continue;
    const slice = dep.summary.slice(0, Math.min(DEP_DIGEST_CHARS, budget));
    budget -= slice.length;
    parts.push(`## Result of prerequisite '${dep.id}' — ${dep.title} [${dep.status}]\n${slice}`);
  }
  return parts.length > 0
    ? `\n\n# Results from prerequisite steps (digests)\n${parts.join('\n\n')}`
    : '';
}

function toNormalizedAgent(step: WorkflowStepState, record: WorkflowRecord): NormalizedAgent {
  const profile = MICRO_AGENT_PROFILES[step.profileId];
  const task = step.prompt + (step.acceptance?.length ? '\nAcceptance criteria:\n' + step.acceptance.join('\n') : '') + buildDependencyContext(record, step);
  const researchPolicy = profile.capability === 'explore' || profile.capability === 'review'
    ? buildResearchPolicy({ task })
    : undefined;
  return {
    task,
    type: profile.capability,
    profile,
    label: step.id,
    maxTurns: 0,
    files: step.files,
    researchPolicy,
  };
}

function emitStepUpdate(ctx: ToolContext, record: WorkflowRecord, step: WorkflowStepState): void {
  emitSubagentEvent(ctx, 'workflow_step_update', {
    workflow_id: record.id,
    step_id: step.id,
    status: step.status,
    ...(step.groupId ? { group_id: step.groupId } : {}),
    ...(step.summary ? { summary: step.summary.slice(0, 500) } : {}),
    ...(step.error ? { error: step.error.slice(0, 500) } : {}),
    ...(step.toolCallCount != null ? { tool_call_count: step.toolCallCount } : {}),
    ...(step.usage ? { usage: step.usage } : {}),
  });
}

async function persist(
  deps: SubagentDeps,
  ctx: ToolContext,
  record: WorkflowRecord,
): Promise<void> {
  const sessionId = ctx.sessionId ?? ctx.runner?.sessionId;
  if (
    sessionId != null &&
    !(await saveWorkflow(sessionId, record, deps.sessionStore))
  ) {
    throw new Error(`workflow '${record.id}' checkpoint commit was fenced`);
  }
}

/** Mark pending steps whose dependencies failed/skipped as skipped (recursive via loop). */
function skipBlockedSteps(ctx: ToolContext, record: WorkflowRecord): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const step of record.steps) {
      if (step.status !== 'pending') continue;
      const bad = step.dependsOn.find((depId) => {
        const dep = record.steps.find((s) => s.id === depId);
        return dep && (dep.status === 'failed' || dep.status === 'skipped'
          || (dep.status === 'partial' && !step.acceptPartial?.includes(depId)));
      });
      if (!bad) continue;
      step.status = 'skipped';
      step.error = `dependency '${bad}' did not complete`;
      emitStepUpdate(ctx, record, step);
      changed = true;
    }
  }
}

export async function executeWorkflow(
  deps: SubagentDeps,
  ctx: ToolContext,
  record: WorkflowRecord,
): Promise<WorkflowRecord> {
  const parentSessionId = ctx.sessionId ?? ctx.runner?.sessionId;
  const activeControllers = new Set<AbortController>();
  let saveQueue = Promise.resolve();
  const checkpoint = () => {
    const snapshot = structuredClone(record);
    saveQueue = saveQueue.then(() => persist(deps, ctx, snapshot));
    return saveQueue;
  };
  const stopLeaseKeepalive = parentSessionId == null
    ? () => {}
    : startWorkflowRunLeaseKeepalive(
        parentSessionId,
        record.id,
        deps.sessionStore,
        (error) => {
          for (const controller of activeControllers) {
            try { controller.abort(error); } catch { /* already terminal */ }
          }
        },
      );
  try {
    let waveNo = 0;
    if (parentSessionId != null) {
      await assertWorkflowRunLease(
        parentSessionId,
        record.id,
        deps.sessionStore,
      );
    }

    await runReadyWorkflow(record, Math.min(deps.maxParallel ?? 3, ctx.ultraPolicy?.effective.parallelism.maxAgents ?? 3), async dispatched => {
      const ready = [dispatched];
      const waveCap = ctx.ultraPolicy?.presetId === 'ultra' ? ctx.ultraPolicy.effective.parallelism.maxWaves : undefined;
      if (waveCap != null && ready.some(step => step.wave > waveCap)) {
        for (const step of ready) { step.status = 'failed'; step.error = 'Ultra workflow wave budget reached; finish with existing results'; emitStepUpdate(ctx, record, step); }
        return;
      }

      waveNo++;
      const groupId = `wf${record.runCount}-${record.id}-w${waveNo}`;
      const agents = ready.map((step) => toNormalizedAgent(step, record));
      const agentProviders = await Promise.all(agents.map((a) => providerForProfile(deps, a.profile)));
      const agentInfos = agentProviders.map((p) => describeProvider(p));
      const agentLimits = agents.map((a) => limitsForAgent(a, deps));
      const controllers = ready.map(() => new AbortController());

      if (parentSessionId != null) {
        await assertWorkflowRunLease(
          parentSessionId,
          record.id,
          deps.sessionStore,
        );
      }
      for (const step of ready) {
        step.status = 'running';
        step.groupId = groupId;
        if (parentSessionId && ctx.collaboration) step.childChatId = childChatId(parentSessionId, `${groupId}:0`);
        emitStepUpdate(ctx, record, step);
      }
      await checkpoint();

      const specs: ParallelAgentSpec[] = agents.map((a, i) => ({
        acceptance: ready[i].acceptance,
        task: taskWithWorkspaceBriefing(a.task, ctx),
        label: a.label,
        maxTurns: 0,
        profile: a.profile.id,
        provider: agentProviders[i],
        reasoningEffort: effortForProfile(deps, a.profile),
        spawnId: groupId,
        systemPrompt: systemPromptForAgent(a),
        researchPolicy: a.researchPolicy,
        allowlist: a.profile.allowlist,
        pathScope: a.profile.pathScopeMode === 'enforce-writes' && a.files && a.files.length > 0
          ? a.files
          : undefined,
        pathScopeMode: a.profile.pathScopeMode,
        limits: agentLimits[i],
        signal: controllers[i].signal,
      }));

      const unregisters: Array<() => void> = [];
      let waveRun: Awaited<ReturnType<typeof runParallelAgents>> | null = null;
      try {
        // Register only after the lease assertion + running-state checkpoint
        // commit. If either fence fails, no phantom active agent or spawn
        // event can escape. The loop also cleans partial registration.
        for (let i = 0; i < ready.length; i++) {
          activeControllers.add(controllers[i]);
          unregisters.push(
            registerActiveAgent(parentSessionId, groupId, i, ready[i].id, controllers[i]),
          );
        }
        emitSubagentEvent(ctx, 'agents_group_start', {
          groupId,
          provider: agentInfos[0]?.provider,
          model: agentInfos[0]?.model,
          agents: agents.map((a, i) => ({
            index: i,
            label: a.label,
            provider: agentInfos[i]?.provider,
            model: agentInfos[i]?.model,
            task: a.task,
            researchDepth: a.researchPolicy?.depth,
            maxToolCalls: agentLimits[i]?.maxToolCalls,
            hardTimeoutMs: agentLimits[i]?.timeoutMs,
          })),
        });
        waveRun = await runParallelAgents(
          {
            provider: deps.provider,
            tools: deps.parentTools,
            ctx,
            sessionId: parentSessionId,
            sessionStore: deps.sessionStore,
            agentLoopV2: ctx.runner?.agentLoopV2 ?? false,
            externalToolTiers: deps.externalToolTiers,
            maxParallel: deps.maxParallel,
          },
          specs,
          MICRO_AGENT_PROFILES.explore.systemPrompt,
          MICRO_AGENT_PROFILES.explore.allowlist,
          (progress) => {
            const info = agentInfos[progress.agentIndex];
            emitSubagentEvent(ctx, 'agent_progress', {
              groupId,
              task: agents[progress.agentIndex]?.task,
              provider: info?.provider,
              model: info?.model,
              ...progress,
            });
          },
        );
      } finally {
        for (const unregister of unregisters) unregister();
        for (const controller of controllers) activeControllers.delete(controller);
      }
      if (!waveRun) throw new Error(`workflow '${record.id}' wave did not start`);

      if (parentSessionId != null) {
        await assertWorkflowRunLease(
          parentSessionId,
          record.id,
          deps.sessionStore,
        );
      }
      const { results, totalUsage } = waveRun;
      addUsage(record.totalUsage, totalUsage);
      for (let i = 0; i < ready.length; i++) {
        const step = ready[i];
        const result = results[i];
        step.result = result.workResult ?? workResult(result);
        step.integration = result.integration;
        step.status = result.workResult?.status === 'failed' ? 'failed' : result.workResult?.status === 'partial' ? 'partial' : result.reason === 'completed'
          ? 'completed'
          : isPartialSubagentReason(result.reason)
            ? 'partial'
            : 'failed';
        step.summary = result.finalText || undefined;
        step.error = step.status === 'failed'
          ? (result.failureDetail ?? result.finalText ?? 'failed')
          : undefined;
        step.effectOutcome = result.effectOutcome;
        if (step.effectOutcome === 'unknown') {
          step.status = 'failed'; step.error = `outcome_unknown: ${step.error ?? 'child effect has no confirmed acknowledgement'}`;
        }
        step.toolCallCount = result.toolCallCount;
        step.usage = result.usage;
        emitStepUpdate(ctx, record, step);
      }
      await checkpoint();

      const outcomeCounts = countSubagentOutcomes(results);
      const resumableCount = await retainSpawnGroup({
        sessionId: parentSessionId,
        spawnId: groupId,
        provider: agentInfos[0]?.provider ?? 'unknown',
        model: agentInfos[0]?.model ?? 'unknown',
        agents: results.map((r, i) => ({
          ...toRetentionAgent(i, agents[i], r, agentLimits[i]),
          toolCallCount: r.toolCallCount,
        })),
        store: deps.sessionStore,
      });
      emitSubagentEvent(ctx, 'agents_group_end', {
        groupId,
        totalUsage,
        agentCount: results.length,
        successCount: outcomeCounts.completedCount,
        ...outcomeCounts,
        resumableCount,
      });
    }, ctx.signal);

    if (parentSessionId != null) {
      await assertWorkflowRunLease(
        parentSessionId,
        record.id,
        deps.sessionStore,
      );
    }
    skipBlockedSteps(ctx, record);
    if (record.status !== 'aborted') record.status = workflowStatusFromSteps(record);
    await persist(deps, ctx, record);
    return record;
  } finally {
    stopLeaseKeepalive();
    for (const controller of activeControllers) {
      try { controller.abort(new Error('workflow executor stopped')); } catch { /* terminal */ }
    }
    activeControllers.clear();
  }
}
