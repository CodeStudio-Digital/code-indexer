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
import type { CoderTool, ToolContext, ToolResult, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import {
  MICRO_AGENT_PROFILE_NAMES,
  MICRO_AGENT_PROFILES,
  resolveMicroAgentProfile,
} from '@mcp/code-agent/tools/micro-agent-profiles.js';
import {
  WORKFLOW_MAX_STEPS,
  assignWaveIndexes,
  countWorkflowOutcomes,
  validateWorkflowSteps,
  type WorkflowRecord,
  type WorkflowStepInput,
  type WorkflowStepState,
} from './workflow-types.js';
import { executeWorkflow } from './workflow-run.js';
import {
  getWorkflow,
  releaseWorkflowRun,
  saveWorkflow,
  tryAcquireWorkflowRun,
} from './workflow-registry.js';

const WORKFLOW_DESC =
  'Run a declarative DAG of subagent steps (Ultra mode). Steps with satisfied `depends_on` run IN PARALLEL; ' +
  'dependents receive bounded digests of their prerequisites’ results. Per-step `profile` picks the toolset ' +
  '(explore/verify/review read-only, implement writes scoped to `files`, full unfiltered).\n' +
  'USE: for multi-step work with a real dependency structure — e.g. N parallel investigations feeding one implementation, then a verify step.\n' +
  'USE: `workflow({resume_workflow_id, retry_failed:true})` to relaunch failed/skipped steps of a previous run without redoing completed ones.\n' +
  "DON'T: wrap a single task — use spawn_agent.\n" +
  "DON'T: mirror an approved task list — execute_tasks already orchestrates it.\n" +
  'Token cost of every step IS billed to this session. Steps are capped at ' +
  `${WORKFLOW_MAX_STEPS}; results stream live to the Workflow card.`;

const workflowSchema: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short workflow name shown in the UI (3-6 words).' },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: WORKFLOW_MAX_STEPS,
      description: 'DAG steps. Order does not matter — `depends_on` decides the waves.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable step id ([a-zA-Z0-9_-], max 40 chars).' },
          title: { type: 'string', description: 'Short visible step title.' },
          prompt: { type: 'string', description: 'Complete, self-contained subagent instructions.' },
          profile: {
            type: 'string',
            enum: MICRO_AGENT_PROFILE_NAMES,
            description: 'Micro-agent profile for this step (default explore).',
          },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of prerequisite steps. Their result digests are injected into this prompt.',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Implement profile: paths this step may write to.',
          },
        },
        required: ['id', 'prompt'],
      },
    },
    resume_workflow_id: { type: 'string', description: 'Existing workflow id to resume instead of creating a new one.' },
    retry_failed: { type: 'boolean', description: 'With resume: reset failed/skipped steps to pending before running.' },
  },
  additionalProperties: false,
} as unknown as JsonSchema;

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
  const hint = counts.failed > 0 || counts.skipped > 0
    ? `\n\n---\n\n[${counts.failed + counts.skipped} step(s) did not complete — ` +
      `workflow({resume_workflow_id:"${record.id}", retry_failed:true}) relaunches them ` +
      `reusing completed results.]`
    : '';
  return header + bodies.join('\n\n---\n\n') + hint;
}

export function buildWorkflowTool(deps: SubagentDeps): CoderTool {
  return {
    name: 'workflow',
    description: maybeTerse(WORKFLOW_DESC),
    parameters: workflowSchema,
    source: 'native',
    mutates: true,
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const sessionId = ctx.runner?.sessionId;
      let record: WorkflowRecord;
      const resumeId = typeof args.resume_workflow_id === 'string' ? args.resume_workflow_id.trim() : '';

      if (resumeId) {
        const existing = sessionId != null ? getWorkflow(sessionId, resumeId) : undefined;
        if (!existing) {
          return err(
            `workflow: unknown workflow '${resumeId}' for this session — it may have expired. ` +
            'Author the DAG again with a fresh workflow({steps:[...]}) call.',
          );
        }
        record = existing;
        for (const step of record.steps) {
          if (step.status === 'running') step.status = 'pending';
          if (args.retry_failed === true && (step.status === 'failed' || step.status === 'skipped')) {
            step.status = 'pending';
            step.error = undefined;
            step.summary = undefined;
          }
        }
        if (!record.steps.some((s) => s.status === 'pending')) {
          return ok(
            `workflow ${record.id} has no pending steps (use retry_failed:true to relaunch ` +
            'failed/skipped ones).\n\n' + renderWorkflowResult(record),
          );
        }
        record.runCount += 1;
        record.status = 'running';
      } else {
        const normalized = normalizeSteps((args.steps ?? []) as WorkflowStepInput[]);
        if (typeof normalized === 'string') return err(normalized);
        record = {
          id: `wf_${randomUUID().slice(0, 8)}`,
          name: String(args.name ?? 'workflow').trim().slice(0, 100) || 'workflow',
          sessionId,
          status: 'running',
          steps: normalized,
          totalUsage: { input_tokens: 0, output_tokens: 0 },
          createdAt: Date.now(),
          updatedAt: Date.now(),
          runCount: 1,
        };
      }

      let totalWaves: number;
      try {
        totalWaves = assignWaveIndexes(record.steps);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
      if (sessionId != null) {
        if (!tryAcquireWorkflowRun(sessionId, record.id)) {
          return err(`workflow: '${record.id}' is already running in this session.`);
        }
        saveWorkflow(sessionId, record);
      }

      ctx.runner?.emit('workflow_run_started', {
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
      ctx.reportProgress?.(`workflow ${record.id}: ${record.steps.length} step(s), ${totalWaves} wave(s)`);
      console.log(
        `[coder s=${sessionId ?? '?'}] workflow ${resumeId ? 'resume' : 'start'} id=${record.id} ` +
        `steps=${record.steps.length} waves=${totalWaves}`,
      );

      try {
        await executeWorkflow(deps, ctx, record);
      } finally {
        if (sessionId != null) releaseWorkflowRun(sessionId, record.id);
        const counts = countWorkflowOutcomes(record);
        ctx.runner?.emit('workflow_run_finished', {
          workflow_id: record.id,
          status: record.status === 'running' ? 'failed' : record.status,
          completed_count: counts.completed + counts.partial,
          failed_count: counts.failed,
          skipped_count: counts.skipped + counts.pending,
          total_usage: record.totalUsage,
        });
      }

      return { ...ok(renderWorkflowResult(record)), subUsage: record.totalUsage };
    },
  };
}
