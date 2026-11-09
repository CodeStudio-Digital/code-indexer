import { WORKFLOW_DESC, workflowSchema } from './workflow-schema.js';
/**
 * workflow — Ultra's standing declarative orchestrator (P0 of the
 * ultra-agent parity plan). The model authors a DAG of typed subagent
 * steps; the tool validates it, runs independent steps in parallel waves
 * via the spawn engine, streams workflow_* events for the live card, and
 * is resumable (`resume_workflow_id` + `retry_failed`) while the process
 * lives. Registered ONLY when the session's execution mode is Ultra (or
 * the `ultracode` turn keyword fired) — see index.ts registration.
 */
import { randomUUID } from 'node:crypto';
import type { CoderTool, ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import {
  MICRO_AGENT_PROFILE_NAMES,
  MICRO_AGENT_PROFILES,
  resolveMicroAgentProfile,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';
import {
  assignWaveIndexes,
  countWorkflowOutcomes,
  validateWorkflowSteps,
  workflowStatusFromSteps,
  workflowStepNeedsReconciliation,
  type WorkflowRecord,
  type WorkflowStepInput,
  type WorkflowStepState,
} from './workflow-types.js';
import { executeWorkflow } from './workflow-run.js';
import { workflowTemplate } from './workflow-templates.js';
import { emitSubagentEvent } from '../subagent-events.js';
type WorkflowStepReconciliation = { outcome: 'terminal' | 'outcome_unknown'; stepStatus?: 'completed' | 'partial' | 'failed'; reason?: string; resultRef?: string; summary?: string; detail: string };
import {
  getWorkflow,
  reloadWorkflowUnderLease,
  releaseWorkflowRun,
  saveWorkflow,
  tryAcquireWorkflowRun,
} from './workflow-registry.js';

function normalizeSteps(raw: WorkflowStepInput[]): WorkflowStepState[] | string {
  const issues = validateWorkflowSteps(raw);
  if (issues.length > 0) {
    return `workflow: invalid steps —\n${issues.map((i) => `- ${i.message}`).join('\n')}`;
  }
  const steps: WorkflowStepState[] = [];
  for (const input of raw) {
    const profile = input.profile ? resolveMicroAgentProfile(input.profile) : MICRO_AGENT_PROFILES.explore;
    if (!profile) {
      return `workflow: step '${input.id}' profile='${input.profile}' invalid — use one of: ${MICRO_AGENT_PROFILE_NAMES.join(', ')}`;
    }
    steps.push({
      id: input.id,
      title: input.title?.trim() || input.id,
      prompt: input.prompt.trim(),
      profileId: profile.id,
      dependsOn: [...new Set(input.depends_on ?? [])],
      acceptPartial: [...new Set(input.accept_partial ?? [])],
      acceptance: input.acceptance?.slice(0, 12),
      files: Array.isArray(input.files)
        ? input.files.filter((f): f is string => typeof f === 'string' && f.length > 0)
        : undefined,
      wave: 0,
      status: 'pending',
    });
  }
  return steps;
}

function renderWorkflowResult(record: WorkflowRecord): string {
  const counts = countWorkflowOutcomes(record);
  const waves = Math.max(0, ...record.steps.map((s) => s.wave));
  const header =
    `[workflow ${record.id} "${record.name}": ${record.status} — ` +
    `${counts.completed}/${record.steps.length} completed, ${counts.partial} partial, ` +
    `${counts.failed} failed, ${counts.skipped} skipped, waves=${waves}, ` +
    `input=${record.totalUsage.input_tokens} output=${record.totalUsage.output_tokens}]\n\n`;
  const bodies = record.steps.map((step) => {
    const meta = [
      `wave=${step.wave}`,
      `profile=${step.profileId}`,
      `status=${step.status}`,
      ...(step.toolCallCount != null ? [`tools=${step.toolCallCount}`] : []),
    ].join(', ');
    const body = step.status === 'skipped' || step.status === 'pending'
      ? (step.error ?? '(not dispatched)')
      : (step.summary ?? step.error ?? '(no summary)');
    return `### step ${step.id} — ${step.title} [${meta}]\n${body}`;
  });
  // Separate section so the dashboard's reload parser never folds the hint
  // into the last step's body.
  const hint = record.steps.some(workflowStepNeedsReconciliation)
    ? '\n\n---\n\n[An effect is uncertain. Reconcile the existing child execution before retrying.]'
    : record.steps.some(step => step.integration?.state === 'pending')
    ? '\n\n---\n\n[Review and integrate child changes before resuming: ' + record.steps.filter(step => step.integration?.state === 'pending').map(step => step.integration!.chatId).join(', ') + ']'
    : counts.failed > 0 || counts.skipped > 0
    ? `\n\n---\n\n[${counts.failed + counts.skipped} step(s) did not complete — ` +
      `workflow({resume_workflow_id:"${record.id}", retry_failed:true}) relaunches them ` +
      `reusing completed results.]`
    : '';
  const integrationIds = record.steps.filter(step => step.integration?.state === 'pending').map(step => step.integration!.chatId);
  const integrationHeader = integrationIds.length ? '\nPending integrations — use these exact chat_id values:\n' + integrationIds.join('\n') + '\n\n' : '';
  return header + integrationHeader + bodies.join('\n\n---\n\n') + hint;
}

function workflowToolResult(
  record: WorkflowRecord,
  content = renderWorkflowResult(record),
  includeUsage = false,
): ToolResult {
  const counts = countWorkflowOutcomes(record);
  const waitingForIntegration = record.status === 'partial' && counts.failed === 0 && counts.partial === 0
    && record.steps.some(step => step.integration?.state === 'pending');
  return {
    ...(record.status === 'completed' || waitingForIntegration ? ok(content) : err(content)),
    ...(record.steps.some(workflowStepNeedsReconciliation) ? { effectOutcome: 'unknown' as const } : {}),
    structuredData: {
      kind: 'workflow_result',
      status: record.status,
      workflowId: record.id,
      planRevision: record.planRevision ?? 1,
      steps: record.steps.map(step => ({ id: step.id, status: step.status, result: step.result, effectOutcome: step.effectOutcome, integration: step.integration })),
      stepCount: record.steps.length,
      completedCount: counts.completed,
      partialCount: counts.partial,
      failedCount: counts.failed,
      skippedCount: counts.skipped + counts.pending,
      stillFailed: counts.partial + counts.failed + counts.skipped + counts.pending,
    },
    ...(includeUsage ? { subUsage: record.totalUsage } : {}),
  };
}

export function buildWorkflowTool(deps: SubagentDeps): CoderTool {
  return {
    name: 'workflow',
    effectBoundary: 'nested',
    description: maybeTerse(WORKFLOW_DESC),
    parameters: workflowSchema,
    source: 'native',
    mutates: true,
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const sessionId = ctx.sessionId ?? ctx.runner?.sessionId;
      const runtimeGeneration = 'legacy_ts';

      const resumeId = typeof args.resume_workflow_id === 'string' ? args.resume_workflow_id.trim() : '';
      let record: WorkflowRecord | undefined;
      let leaseAcquired = false;
      let runStarted = false;
      try {
        if (resumeId) {
          const observed = sessionId != null
            ? await getWorkflow(
                sessionId,
                resumeId,
                deps.sessionStore,
              )
            : undefined;
          if (!observed) {
            return err(
              `workflow: unknown workflow '${resumeId}' for this session — it may have expired. ` +
              'Author the DAG again with a fresh workflow({steps:[...]}) call.',
            );
          }
          if (sessionId != null) {
            // Acquire before touching the cache object. After the CAS, discard
            // the pre-acquire observation and reload the authoritative row:
            // another executor may have completed steps in between.
            if (
              !(await tryAcquireWorkflowRun(
                sessionId,
                resumeId,
                deps.sessionStore,
              ))
            ) {
              return err(`workflow: '${resumeId}' is already running in this session.`);
            }
            leaseAcquired = true;
            record = await reloadWorkflowUnderLease(
              sessionId,
              resumeId,
              deps.sessionStore,
            );
            if (!record) {
              return err(
                `workflow: recovery checkpoint for '${resumeId}' changed while acquiring; ` +
                'nothing was relaunched.',
              );
            }
          } else {
            record = observed;
          }
          if ((record.runtimeGeneration ?? 'legacy_ts') !== runtimeGeneration) {
            return err('workflow: this saved workflow belongs to an unavailable runtime and cannot be resumed.');
          }
          // Observe only the receipt written by the normal authorized integration tool.
          // The workflow never invokes a mutating tool behind the dispatcher's back.
          for (const step of record.steps) if (step.integration?.state === 'pending' && ctx.collaboration) {
            const receipt = await ctx.collaboration.store.files.get<{ integrated?: boolean }>('checkpoints', 'workspace:' + step.integration.chatId);
            if (receipt?.integrated) step.integration.state = 'integrated';
          }
          // A model-authored retry flag cannot authorize repeating an uncertain
          // effect. Reconcile such children on every resume until durable
          // evidence establishes a terminal outcome.
          const retryableAtEntry = new Set(
            record.steps
              .filter((step) => !workflowStepNeedsReconciliation(step) && (step.status === 'failed' || step.status === 'skipped'))
              .map((step) => step.id),
          );
          for (const step of record.steps) {
            if (step.status !== 'running' && !workflowStepNeedsReconciliation(step)) continue;
            const reconciliation: WorkflowStepReconciliation = sessionId != null
              && step.groupId
              && deps.sessionStore?.reconcileWorkflowStepRun
              ? await deps.sessionStore.reconcileWorkflowStepRun(
                  sessionId,
                  step.groupId,
                  step.id,
                )
              : {
                  outcome: 'outcome_unknown' as const,
                  detail: step.groupId
                    ? 'durable AgentRun reconciliation is unavailable'
                    : 'the running checkpoint has no idempotency group id',
                };
            if (reconciliation.outcome === 'terminal' && !/outcome[_ ]unknown/i.test(reconciliation.reason ?? '')) {
              step.effectOutcome = undefined;
              step.status = reconciliation.stepStatus ?? 'failed';
              if (step.childChatId && ctx.collaboration) {
                const files = ctx.collaboration.store.files;
                const checkpoint = await files.get<{ result?: WorkflowStepState['result']; workspaceReady?: boolean }>('checkpoints', step.childChatId);
                const workspace = await files.get<{ integrated: boolean; files: string[] }>('checkpoints', 'workspace:' + step.childChatId);
                if (workspace && !checkpoint?.workspaceReady) {
                  step.status = 'failed'; step.effectOutcome = 'unknown';
                  step.error = 'outcome_unknown: child terminated before isolated changes were captured. Reconcile its existing workspace.';
                  continue;
                }
                if (checkpoint?.result) step.result = checkpoint.result;
                if (workspace?.files.length) step.integration = { chatId: step.childChatId, state: workspace.integrated ? 'integrated' : 'pending' };
              }
              const reference = reconciliation.resultRef
                ? ` Result reference: ${reconciliation.resultRef}.`
                : '';
              if (step.status === 'completed' || step.status === 'partial') {
                step.summary = reconciliation.summary ??
                  `[reconciled after executor crash: ${reconciliation.detail}.` +
                  `${reference || ' Result body was not recoverable from the bounded checkpoint.'}]`;
                step.error = undefined;
              } else {
                step.summary = undefined;
                step.error =
                  `reconciled terminal child failure (${reconciliation.reason ?? 'unknown'}): ` +
                  reconciliation.detail;
              }
            } else {
              step.status = 'failed';
              step.effectOutcome = 'unknown';
              step.summary = undefined;
              step.error =
                `outcome_unknown: ${reconciliation.detail}. No automatic retry was performed. ` +
                'Reconcile the durable child execution before retrying. A retry flag does not authorize repeating an uncertain effect.';
            }
          }
          for (const step of record.steps) {
            if (args.retry_failed === true
              && !workflowStepNeedsReconciliation(step)
              && retryableAtEntry.has(step.id)
              && (step.status === 'failed' || step.status === 'skipped')) {
              step.status = 'pending';
              step.error = undefined;
              step.summary = undefined;
            }
          }
          if (!record.steps.some((s) => s.status === 'pending') && args.steps === undefined) {
            record.status = workflowStatusFromSteps(record);
            if (
              sessionId != null &&
              !(await saveWorkflow(
                sessionId,
                record,
                deps.sessionStore,
              ))
            ) {
              return err(`workflow: recovery classification for '${record.id}' was fenced.`);
            }
            const content = `workflow ${record.id} has no pending steps. ` +
              (record.steps.some(workflowStepNeedsReconciliation)
                ? 'Uncertain effects require durable reconciliation before retry. '
                : 'Use retry_failed:true to relaunch failed/skipped steps. ') +
              '\n\n' + renderWorkflowResult(record);
            return workflowToolResult(record, content);
          }
        } else {
          const normalized = normalizeSteps((args.steps ?? (args.template ? workflowTemplate(String(args.template), String(args.task ?? ''), args.files as string[] | undefined) : [])) as WorkflowStepInput[]);
          if (typeof normalized === 'string') return err(normalized);
          record = {
            id: `wf_${randomUUID().slice(0, 8)}`,
            name: String(args.name ?? 'workflow').trim().slice(0, 100) || 'workflow',
            sessionId,
            runtimeGeneration,
            planRevision: 1,
            status: 'running',
            steps: normalized,
            totalUsage: { input_tokens: 0, output_tokens: 0 },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            runCount: 1,
          };
        }

        if (resumeId && args.steps !== undefined) {
          if (args.expected_plan_revision !== (record.planRevision ?? 1)) return err('revision_conflict: reload the saved workflow before changing its plan');
          const revised = normalizeSteps(args.steps as WorkflowStepInput[]);
          if (typeof revised === 'string') return err(revised);
          for (const previous of record.steps) {
            const next = revised.find(step => step.id === previous.id);
            if (previous.status === 'running' || workflowStepNeedsReconciliation(previous)) return err('effect_unknown: reconcile running steps before revising the plan');
            if (previous.status === 'completed' || previous.status === 'partial') {
              if (!next || next.prompt !== previous.prompt || next.profileId !== previous.profileId
                || JSON.stringify(next.dependsOn) !== JSON.stringify(previous.dependsOn)
                || JSON.stringify(next.files) !== JSON.stringify(previous.files)
                || JSON.stringify(next.acceptance ?? []) !== JSON.stringify(previous.acceptance ?? [])
                || JSON.stringify(next.acceptPartial ?? []) !== JSON.stringify(previous.acceptPartial ?? [])) return err('Completed work is immutable; add a successor step instead');
              Object.assign(next, previous);
            }
          }
          record.planHistory = [...(record.planHistory ?? []), { revision: record.planRevision ?? 1, at: Date.now(), stepIds: record.steps.map(step => step.id) }].slice(-16);
          record.steps = revised;
          record.planRevision = (record.planRevision ?? 1) + 1;
        }
        if (resumeId) { record.runCount += 1; record.status = 'running'; }
        let totalWaves: number;
        try {
          totalWaves = assignWaveIndexes(record.steps);
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e));
        }
        if (sessionId != null) {
          // A fresh workflow must have a durable row before the cross-process
          // lease CAS. A resume already acquired and reloaded above.
          if (!resumeId) {
            if (
              !(await saveWorkflow(
                sessionId,
                record,
                deps.sessionStore,
              ))
            ) {
              return err(
                `workflow: unable to persist bounded recovery checkpoint for '${record.id}'; ` +
                'the workflow was not started.',
              );
            }
            if (
              !(await tryAcquireWorkflowRun(
                sessionId,
                record.id,
                deps.sessionStore,
              ))
            ) {
              return err(`workflow: '${record.id}' is already running in this session.`);
            }
            leaseAcquired = true;
          }
          if (
            !(await saveWorkflow(
              sessionId,
              record,
              deps.sessionStore,
            ))
          ) {
            return err(`workflow: recovery checkpoint for '${record.id}' was fenced or unavailable.`);
          }
        }

        emitSubagentEvent(ctx, 'workflow_run_started', {
          workflow_id: record.id,
          name: record.name,
          ...(resumeId ? { resumed: true } : {}),
          total_waves: totalWaves,
          steps: record.steps.map((s) => ({
            id: s.id,
            title: s.title,
            profile: s.profileId,
            depends_on: s.dependsOn,
            wave: s.wave,
            status: s.status,
          })),
        });
        runStarted = true;
        ctx.reportProgress?.(`workflow ${record.id}: ${record.steps.length} step(s), ${totalWaves} wave(s)`);
        console.log(
          `[coder s=${sessionId ?? '?'}] workflow ${resumeId ? 'resume' : 'start'} id=${record.id} ` +
          `steps=${record.steps.length} waves=${totalWaves}`,
        );
        await executeWorkflow(deps, ctx, record);
        if (record.steps.some(step => step.integration?.state === 'pending')) {
          // Request the next two schemas; ordinary projection/dispatch still
          // decides visibility and authorization. This never executes either tool.
          ctx.runner?.promoteTool?.('read_chat_changes');
          ctx.runner?.promoteTool?.('integrate_chat_changes');
        }
        return workflowToolResult(record, renderWorkflowResult(record), true);
      } catch (error) {
        // Once the workflow id exists, convert fatal execution failures into a
        // structured tool error. This preserves the opaque recovery identity
        // in the root ledger even when a provider/lease failure interrupted
        // the normal terminal renderer.
        if (!record) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        // The wave may have executed effects before its final checkpoint failed.
        // Keep its identity and fail closed rather than returning a retryable run.
        for (const step of record.steps) if (step.status === 'running') {
          step.status = 'failed'; step.effectOutcome = 'unknown';
          step.error = 'outcome_unknown: wave stopped before its terminal checkpoint';
        }
        return workflowToolResult(
          record,
          `workflow ${record.id} failed before a terminal checkpoint: ${detail}`,
          true,
        );
      } finally {
        if (sessionId != null && leaseAcquired && record) {
          await releaseWorkflowRun(
            sessionId,
            record.id,
            deps.sessionStore,
          );
        }
        if (runStarted && record) {
          const counts = countWorkflowOutcomes(record);
          emitSubagentEvent(ctx, 'workflow_run_finished', {
            workflow_id: record.id,
            status: record.status === 'running' ? 'failed' : record.status,
            completed_count: counts.completed + counts.partial,
            failed_count: counts.failed,
            skipped_count: counts.skipped + counts.pending,
            total_usage: record.totalUsage,
          });
        }
      }
    },
  };
}
