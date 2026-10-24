/**
 * resume_agent — relaunch failed ephemeral subagents FROM WHERE THEY STOPPED.
 *
 * The parent LLM discovers this tool from the footer appended to any spawn
 * result that had failed agents ("resume_agent({spawn_id:…})"). It reads a
 * retained transcript from the resume registry, appends a reason-specific
 * continuation nudge, and relaunches through the existing parallel worker pool
 * under the SAME groupId (UI rows flip back to running with a retry chip).
 *
 * Selection: by default targets agents that failed for a re-tryable reason
 * (tool_budget / timeout / crash). `aborted` (user stopped it) and `quality`
 * (monologuing) resume ONLY when named explicitly in `agents`. Total attempts
 * are capped server-side — no budget knob for the model to burn.
 */
import type { CoderTool, ToolResult, ToolContext } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import type { SubagentDeps } from '@mcp/code-agent/tools/subagent.js';
import { classifyResumeKind } from '@mcp/code-agent/tools/resume-nudges.js';
import { relaunchResumedAgents } from '@mcp/code-agent/tools/resume-run.js';
import {
  getGroup,
  reloadGroupUnderLease,
  tryAcquireResume,
  releaseResume,
  resumeNeedsReconciliation,
  type ResumableAgentState,
} from '@mcp/code-agent/tools/subagent-resume-registry.js';

const MAX_ATTEMPTS = 3;
const QUALITY_MAX_ATTEMPTS = 2;

const RESUME_DESC =
  'Relaunch failed subagent(s) from a previous spawn_agent, keeping their progress (transcript) intact. ' +
  'Use the `spawn=`/`group=` id from the spawn result. Prefer this over re-spawning a failed task from scratch. ' +
  'By default retries agents that ran out of budget, timed out, or crashed; pass `agents` to also retry aborted/low-quality ones. ' +
  'Add `guidance` when you know what went wrong (e.g. "the test command is pnpm test, not npm").';

function attemptCap(state: ResumableAgentState): number {
  return classifyResumeKind(state.reason, state.failureNote) === 'quality' ? QUALITY_MAX_ATTEMPTS : MAX_ATTEMPTS;
}

function canResume(state: ResumableAgentState): boolean {
  return !resumeNeedsReconciliation(state) && state.reason !== 'completed'
    && !!(state.transcript || state.nativeTranscriptRef)
    && state.attempt < attemptCap(state);
}

export function buildResumeAgentTool(deps: SubagentDeps): CoderTool {
  return {
    name: 'resume_agent',
    effectBoundary: 'nested',
    description: RESUME_DESC,
    source: 'native',
    parallelSafe: false,
    riskLevel: 'admin',
    executionClass: 'execute',
    parameters: {
      type: 'object',
      properties: {
        spawn_id: { type: 'string', description: 'The `spawn=<id>` or `group=<id>` token from the spawn result header.' },
        agents: {
          type: 'array',
          items: { type: 'number' },
          description: '1-based agent numbers (matches "### Agent N"). Omit to retry every re-tryable failed agent.',
        },
        guidance: { type: 'string', description: 'Optional corrective instruction passed to the resumed agent(s).' },
      },
      required: ['spawn_id'],
      additionalProperties: false,
    },
    handler: async (args, ctx: ToolContext): Promise<ToolResult> => {
      const spawnId = typeof args.spawn_id === 'string' ? args.spawn_id.trim() : '';
      if (!spawnId) return err('resume_agent: `spawn_id` is required.');
      const sessionId = ctx.runner?.sessionId ?? ctx.sessionId;
      if (sessionId == null) return err('resume_agent: no active session.');

      const observed = await getGroup(
        sessionId,
        spawnId,
        deps.sessionStore,
      );
      if (!observed) {
        return err(
          `resume_agent: spawn '${spawnId}' not found — resumable states live ~45min in this session only. ` +
          `Re-run the task with spawn_agent instead.`,
        );
      }
      if (
        !(await tryAcquireResume(
          sessionId,
          spawnId,
          deps.sessionStore,
        ))
      ) {
        return err(`resume_agent: spawn '${spawnId}' is already being resumed. Wait for it to finish.`);
      }

      try {
        // The cache-first observation above is only an existence hint. A
        // different executor may commit and release between that read and our
        // CAS, so target selection must use a fresh snapshot under the lease.
        const group = await reloadGroupUnderLease(
          sessionId,
          spawnId,
          deps.sessionStore,
        );
        if (!group) {
          return err(
            `resume_agent: spawn '${spawnId}' changed while acquiring its recovery checkpoint; ` +
            'nothing was relaunched.',
          );
        }
        // Completed agents may ALSO carry a transcript now (observability
        // retention — read_agent_transcript). Only a fully completed roster is
        // a successful no-op; unfinished agents with expired/capped state must
        // remain an error so the root ledger cannot treat them as recovered.
        const unfinished = group.agents.filter((a) => a.reason !== 'completed');
        if (unfinished.length === 0) {
          return ok(`resume_agent: nothing to resume in '${spawnId}' — all agents completed.`);
        }

        const explicit = Array.isArray(args.agents)
          ? new Set((args.agents as unknown[]).filter((n): n is number => typeof n === 'number').map((n) => n - 1))
          : null;

        const skipped: string[] = [];
        const targets: ResumableAgentState[] = [];
        for (const state of unfinished) {
          if (resumeNeedsReconciliation(state)) {
            skipped.push(`#${state.agentIndex + 1} ${state.label} (outcome_unknown: reconcile the existing effect before resuming)`);
            continue;
          }
          const kind = classifyResumeKind(state.reason, state.failureNote);
          const chosen = explicit ? explicit.has(state.agentIndex) : kind !== 'aborted' && kind !== 'quality';
          if (!chosen) {
            if (!explicit) skipped.push(`#${state.agentIndex + 1} ${state.label} (${kind} — name it in \`agents\` to retry)`);
            continue;
          }
          if (state.nativeTranscriptRef && (ctx.runtimeGeneration !== 'rust_v1' || ctx.ports?.agentTree?.runtimeGeneration !== 'rust_v1')) {
            skipped.push(`#${state.agentIndex + 1} ${state.label} (native continuation requires its owned Rust tree)`);
            continue;
          }
          if (!state.transcript && !state.nativeTranscriptRef) {
            skipped.push(`#${state.agentIndex + 1} ${state.label} (resume state expired — re-spawn or decompose the task)`);
            continue;
          }
          if (state.attempt >= attemptCap(state)) {
            skipped.push(`#${state.agentIndex + 1} ${state.label} (attempt cap ${attemptCap(state)} reached — decompose the task instead)`);
            continue;
          }
          targets.push(state);
        }
        const unresolvedEffect = unfinished.some(resumeNeedsReconciliation);
        if (unresolvedEffect) targets.length = 0;

        if (targets.length === 0) {
          const why = skipped.length ? `\nSkipped: ${skipped.join('; ')}` : '';
          const retryable = !unresolvedEffect && unfinished.some(canResume);
          const status = group.agents.some((state) => state.reason === 'completed')
            ? 'partial'
            : 'failed';
          return {
            content: `resume_agent: no eligible agents to resume in '${spawnId}'.${why}`,
            isError: true,
            ...(unfinished.some(resumeNeedsReconciliation) ? { effectOutcome: 'unknown' as const } : {}),
            error: {
              code: retryable ? 'RESUME_AGENT_INCOMPLETE' : 'RESUME_AGENT_EXHAUSTED',
              kind: 'tool_error',
              retryable,
              suggestedAction: unresolvedEffect ? 'Reconcile the existing child effect before continuing or spawning replacement work.' : retryable
                ? `Retry resume_agent with spawn_id '${spawnId}' and explicitly select the unfinished agents.`
                : 'No unfinished agent has a resumable attempt left; decompose the task or spawn narrowly scoped replacement work.',
            },
            structuredData: {
              kind: 'resume_agent_result',
              status,
              spawnId,
              relaunchedCount: 0,
              completedCount: 0,
              partialCount: 0,
              failedCount: 0,
              stillFailed: unfinished.length,
              remainingCount: unfinished.length,
              skippedCount: skipped.length,
            },
          };
        }

        const guidance = typeof args.guidance === 'string' ? args.guidance : undefined;
        const outcome = await relaunchResumedAgents(deps, ctx, group, targets, guidance);
        const tail = skipped.length ? `\n\n[also skipped: ${skipped.join('; ')}]` : '';
        const content = outcome.text + tail;
        const remaining = group.agents.filter((state) => state.reason !== 'completed');
        const remainingCount = remaining.length;
        const status = remainingCount === 0
          ? 'completed'
          : outcome.completedCount > 0
              || outcome.partialCount > 0
              || group.agents.some((state) => state.reason === 'completed')
            ? 'partial'
            : 'failed';
        const structuredData = {
          kind: 'resume_agent_result',
          status,
          spawnId,
          relaunchedCount: outcome.relaunchedCount,
          completedCount: outcome.completedCount,
          partialCount: outcome.partialCount,
          failedCount: outcome.failedCount,
          stillFailed: remainingCount,
          remainingCount,
          skippedCount: skipped.length,
        };
        if (remainingCount > 0) {
          const partial = status === 'partial';
          const uncertain = outcome.effectOutcome === 'unknown' || remaining.some(resumeNeedsReconciliation);
          const retryable = !uncertain && remaining.some(canResume);
          const incompleteBecauseSkipped = outcome.stillFailed === 0;
          const errorCode = incompleteBecauseSkipped
            ? retryable ? 'RESUME_AGENT_INCOMPLETE' : 'RESUME_AGENT_EXHAUSTED'
            : partial ? 'RESUME_AGENT_PARTIAL' : 'RESUME_AGENT_FAILED';
          return {
            content,
            isError: true,
            ...(outcome.effectOutcome === 'unknown' || remaining.some(resumeNeedsReconciliation) ? { effectOutcome: 'unknown' as const } : {}),
            error: {
              code: errorCode,
              kind: 'tool_error',
              retryable,
              suggestedAction: uncertain ? 'Reconcile the existing child effect before continuing or spawning replacement work.' : retryable
                ? `Retry resume_agent with spawn_id '${spawnId}' to continue only the unfinished agents.`
                : 'No unfinished agent has a resumable attempt left; decompose or narrow the task before spawning replacement work.',
            },
            structuredData,
            subUsage: outcome.usage,
          };
        }
        return {
          ...ok(content),
          structuredData,
          subUsage: outcome.usage,
        };
      } finally {
        await releaseResume(sessionId, spawnId, deps.sessionStore);
      }
    },
  };
}
