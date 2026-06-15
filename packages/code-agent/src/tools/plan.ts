import { createHash } from 'node:crypto';
import type { CoderTool, ToolResult, ToolContext } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { SUBMIT_PLAN_DESC, maybeTerse } from '@mcp/code-agent/tools/descriptions.js';
import { formatInterruptedResult } from '@mcp/code-agent/tools/interaction.js';

/**
 * Per-runner short-lived ledger of plans the user already rejected. Stops
 * the model from re-submitting the same prose with cosmetic tweaks after a
 * rejection — common doom-loop pattern. Cleared automatically when a plan
 * is approved (the agent has moved on; a future re-submission would be a
 * legitimately new plan).
 */
const REJECTED_PLAN_HASHES = new WeakMap<object, Set<string>>();
function hashPlan(text: string): string {
  return createHash('sha1').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

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
  return `Plan rejected by user.${feedback ? ` Feedback: ${feedback}` : ''} Revise the plan and call submit_plan again before mutating tools.`;
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
export function applyPlanApproval(
  runner: NonNullable<ToolContext['runner']>,
  ctx: ToolContext,
): Pick<ToolResult, 'extraUserBlocks'> {
  runner.approvePlan();
  if (runner.agentId !== 'plan') return {};
  ctx.setSessionAgent?.('build');
  return {
    extraUserBlocks: [
      {
        type: 'text',
        text:
          '<system-reminder>Mode transition: Plan → Build. The plan was approved. ' +
          'Now execute it per build-mode instructions: read with prepare_edit / get_symbol_body ' +
          'before editing, apply changes, run the project verify (npm test / pnpm typecheck / ' +
          'appropriate) after each batch, and report concrete diffs. No further plan submission ' +
          'needed — proceed directly to edits.</system-reminder>',
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
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'Numbered, concise plan of the next concrete steps you intend to take. ' +
          'For informational answers, use a 1-line plan describing what you are about to explain — ' +
          'the user still needs to approve before you continue.',
      },
      kind: {
        type: 'string',
        enum: ['informational', 'mutating'],
        description:
          'Optional. "informational" hints the plan is an answer-only deliverable (no edits/shell follow-up); ' +
          'when no mutating tool ran in the last few turns, the runner may still pause for user review but the ' +
          'dashboard shows a quick-approve cue. Default: "mutating".',
      },
    },
    required: ['plan'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const plan = String(args.plan ?? '').trim();
    if (!plan) return err('plan cannot be empty');
    const kind = args.kind === 'informational' ? 'informational' : 'mutating';
    const runner = ctx.runner;
    if (!runner) return err('plan tool requires runner context');

    // Idempotency guard: if the user already rejected this exact plan in
    // this session, refuse the resubmission instead of pausing the runner
    // again. The model should read the prior feedback (already in history)
    // and produce a materially different plan, not retry with cosmetic
    // edits.
    const hash = hashPlan(plan);
    let rejected = REJECTED_PLAN_HASHES.get(runner as unknown as object);
    if (!rejected) {
      rejected = new Set();
      REJECTED_PLAN_HASHES.set(runner as unknown as object, rejected);
    }
    if (rejected.has(hash)) {
      return err(
        `This plan was already rejected by the user in this session (hash=${hash}). ` +
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

    const id = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // Persist the plan up-front so the dashboard's "Plans" tab shows it
    // even while still pending. The status is updated below once the
    // user responds.
    ctx.recordPlan?.(id, plan);
    runner.emit('plan_posted', { type: 'plan', id, plan, kind });

    const raw = await runner.waitForUserInput();
    let parsed: {
      approved?: boolean;
      feedback?: string;
      aborted?: boolean;
      interrupted?: boolean;
      kind?: 'plan' | 'question' | 'tasks';
      agentRunId?: number;
      role?: string;
    };
    try { parsed = JSON.parse(raw); } catch { parsed = { approved: false, feedback: raw }; }

    if (parsed.interrupted) {
      // Don't record any verdict — the user never saw the plan. Re-submission
      // (with the same hash) is allowed once the urgent event clears.
      return err(formatInterruptedResult('submit_plan', parsed));
    }
    if (parsed.aborted) {
      ctx.resolvePlan?.(id, 'aborted', parsed.feedback);
      return err('Plan review aborted by user.');
    }
    if (parsed.approved) {
      ctx.resolvePlan?.(id, 'approved', parsed.feedback);
      // A new approval clears prior rejections — the model has moved on, and
      // any future plan with the same text would be a legitimately new ask.
      rejected.clear();
      // Auto plan→build after approval: unlock this run, persist `build` for
      // the next runner, and inject a <system-reminder> so the live model
      // switches gears immediately. See applyPlanApproval.
      const extras = applyPlanApproval(runner, ctx);
      return { content: formatPlanResult(true, parsed.feedback), ...extras };
    }
    rejected.add(hash);
    ctx.resolvePlan?.(id, 'rejected', parsed.feedback);
    return ok(formatPlanResult(false, parsed.feedback));
  },
};

export const planTools: CoderTool[] = [submitPlan];
