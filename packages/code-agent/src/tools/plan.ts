import { createHash } from 'node:crypto';
import type { CoderTool, ToolResult, ToolContext } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { SUBMIT_PLAN_DESC, maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import { formatInterruptedResult } from '@mcp/code-agent/tools/interaction.js';
import { toolInteractions } from '../core/tool-interactions.js';
import type { InteractiveToolPort } from '../ports/interactive-tool-port.js';

/**
 * Per-runner short-lived ledger of plans the user requested revisions for. Stops
 * the model from re-submitting the same prose with cosmetic tweaks after a
 * revision request — common doom-loop pattern. Cleared automatically when a plan
 * is approved (the agent has moved on; a future re-submission would be a
 * legitimately new plan).
 */
const REVISE_REQUESTED_PLAN_HASHES = new WeakMap<object, Set<string>>();
function hashPlan(text: string): string {
  return createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

/** A Build session can reopen review of its latest approved plan. */
export function approvedPlanForRevision(
  ctx: ToolContext,
  runner: Pick<NonNullable<ToolContext['runner']>, 'agentId' | 'planMode' | 'specMode' | 'isSubagent'> | undefined = ctx.runner,
): { text: string } | undefined {
  if (runner?.agentId !== 'build' || runner.planMode || runner.specMode || runner.isSubagent
      || ctx.companyContext || !ctx.setSessionAgent) return undefined;
  const plan = ctx.getActivePlan?.();
  return plan?.status === 'approved' ? plan : undefined;
}

export const PLAN_APPROVAL_REMINDER =
  '<system-reminder>Mode transition: Plan → Build. Implement the approved plan and verify the changes. ' +
  'If the user asks to revise this plan, call the visible submit_plan directly with the updated plan and revision: true before making further changes. ' +
  'If the review tool is unavailable, explain that a new review requires Plan mode.</system-reminder>';

/**
 * Format the tool_result content for a submit_plan response. Shared between
 * the live tool handler and the server-side resume path so a session resumed
 * after a restart produces the byte-identical message the runner would have
 * produced in-process.
 */
export function formatPlanResult(approved: boolean, feedback?: string): string {
  if (approved) {
    return `Plan approved by user.${feedback ? ` Feedback: ${feedback}` : ''} You may now proceed with mutating tools.`;
  }
  return `Plan revision requested by user.${feedback ? ` Feedback: ${feedback}` : ''} Revise the plan and call submit_plan again before mutating tools.`;
}

/**
 * Apply the plan→build transition after a plan is approved. Unlocks mutating
 * tools in-memory for this run (`approvePlan`) and, when the run started in the
 * `plan` agent, persists the switch to `build` for the next runner creation
 * (`setSessionAgent`) plus returns a `<system-reminder>` block so the live
 * model switches gears in the same turn.
 *
 * Single-sourced here and reused by `submit_plan` (canonical approval path) and
 * `execute_tasks` (when a model uses execute_tasks as its "plan is ready, go"
 * signal in plan mode). The reminder rides as `extraUserBlocks` — not a direct
 * appendSystemReminder — so it lands AFTER the tool_result, preserving the
 * `assistant(tool_use) → tool → user` adjacency strict providers require.
 */
export async function applyPlanApproval(
  runner: Pick<InteractiveToolPort, 'approvePlan' | 'agentId'>,
  ctx: ToolContext,
): Promise<Pick<ToolResult, 'extraUserBlocks'>> {
  runner.approvePlan();
  if (runner.agentId !== 'plan') return {};
  await ctx.setSessionAgent?.('build');
  return {
    extraUserBlocks: [
      {
        type: 'text',
        text: PLAN_APPROVAL_REMINDER,
      },
    ],
  };
}

/**
 * Plan-mode tool: agent submits a plan, run pauses, host (CLI/SSE) collects
 * user approval and resumes via runner.provideUserInput.
 */
export const submitPlan: CoderTool = {
  name: 'submit_plan',
  description: maybeTerse(SUBMIT_PLAN_DESC),
  source: 'native',
  mutates: false, parallelSafe: false, riskLevel: 'read', interactive: true, effectBoundary: 'control',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'The full draft for review, including the approach and verification. Answer ordinary factual questions directly.',
      },
      kind: {
        type: 'string',
        enum: ['informational', 'mutating'],
        description:
          'Optional. "informational" hints the plan is an answer-only deliverable (no edits/shell follow-up); ' +
          'when no mutating tool ran in the last few turns, the runner may still pause for user review but the ' +
          'dashboard shows a quick-approve cue. Default: "mutating".',
      },
      revision: {
        type: 'boolean',
        description: 'In Build, set to true only when the user asks to revise the approved plan. Submitting it reopens Plan and pauses for a new approval.',
      },
    },
    required: ['plan'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const plan = String(args.plan ?? '').trim();
    if (!plan) return err('plan cannot be empty');
    const kind = args.kind === 'informational' ? 'informational' : 'mutating';
    const runner = toolInteractions(ctx);
    if (!runner) return err('plan tool requires interaction context');
    if (runner.specMode) {
      return err(
        'submit_plan is unavailable in spec mode. Call submit_spec with the complete specification; ' +
          'approving a regular plan cannot release the spec gate.',
      );
    }
    const fromBuild = runner.agentId === 'build' && !(ctx.runner?.planMode ?? ctx.planMode);
    const approvedPlan = fromBuild ? approvedPlanForRevision(ctx) : undefined;
    if (fromBuild && (!approvedPlan || args.revision !== true)) {
      return err('In Build, submit_plan is reserved for a user-requested revision of the latest approved plan. Pass revision: true with the updated plan. For a new plan, select Plan mode.');
    }

    // Idempotency guard: if the user already requested revisions to this exact plan in
    // this session, refuse the resubmission instead of pausing the runner
    // again. The model should read the prior feedback (already in history)
    // and produce a materially different plan, not retry with cosmetic
    // edits.
    const hash = hashPlan(plan);
    if (approvedPlan && hashPlan(approvedPlan.text) === hash) {
      return err('This is the already approved plan. Apply the requested changes to the plan before submitting it for review.');
    }
    let reviseRequested = REVISE_REQUESTED_PLAN_HASHES.get(runner as unknown as object);
    if (!reviseRequested) {
      reviseRequested = new Set();
      REVISE_REQUESTED_PLAN_HASHES.set(runner as unknown as object, reviseRequested);
    }
    if (reviseRequested.has(hash)) {
      return err(
        `The user already requested revisions to this plan in this session (hash=${hash}). ` +
          `Read the feedback in the prior submit_plan tool_result and submit a materially different plan ` +
          `that addresses it — do not re-submit with cosmetic tweaks.`,
      );
    }

    // No auto-approve shortcut: every plan, informational or not, pauses
    // for explicit user review. The previous /^no changes needed/ regex
    // was abused by the model as a fast-path to terminate runs without
    // ever pausing for the human, even for analysis/refactoring tasks
    // whose output IS the plan. Removing it costs an extra click on
    // trivial questions but eliminates the bypass entirely. The new
    // `kind` field lets the dashboard present a quick-approve hint for
    // informational plans without re-introducing the bypass.

    const id = ctx.ports?.interactions && ctx.currentToolUseId
      ? ctx.currentToolUseId : `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (approvedPlan) await ctx.setSessionAgent?.('plan');
    // Persist the plan up-front so the dashboard's "Plans" tab shows it
    // even while still pending. The status is updated below once the
    // user responds.
    await ctx.recordPlan?.(id, plan);
    const raw = await runner.request({ kind: 'plan', payload: { type: 'plan', id, plan, kind } });
    let parsed: {
      approved?: boolean;
      feedback?: string;
      aborted?: boolean;
      interrupted?: boolean;
      kind?: 'plan' | 'question' | 'tasks';
      agentRunId?: string | null;
      role?: string;
    };
    try { parsed = JSON.parse(raw); } catch { parsed = { approved: false, feedback: raw }; }

    if (parsed.interrupted) {
      // Don't record any verdict — the user never saw the plan. Re-submission
      // (with the same hash) is allowed once the urgent event clears.
      return err(formatInterruptedResult('submit_plan', parsed));
    }
    if (parsed.aborted) {
      await ctx.resolvePlan?.(id, 'aborted', parsed.feedback);
      return err(`Plan rejected by user.${parsed.feedback ? ` Feedback: ${parsed.feedback}` : ''} Planning review ended.`);
    }
    if (parsed.approved) {
      await ctx.resolvePlan?.(id, 'approved', parsed.feedback);
      // A new approval clears prior revision requests — the model has moved on, and
      // any future plan with the same text would be a legitimately new ask.
      reviseRequested.clear();
      // Auto plan→build after approval: unlock this run, persist `build` for
      // the next runner, and inject a <system-reminder> so the live model
      // switches gears immediately. See applyPlanApproval.
      const extras = await applyPlanApproval(runner, ctx);
      return { content: formatPlanResult(true, parsed.feedback), ...extras };
    }
    reviseRequested.add(hash);
    await ctx.resolvePlan?.(id, 'rejected', parsed.feedback);
    return ok(formatPlanResult(false, parsed.feedback));
  },
};

export const planTools: CoderTool[] = [submitPlan];
