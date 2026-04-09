import type { CoderTool, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';
import { SUBMIT_PLAN_DESC, maybeTerse } from './descriptions.js';

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
    },
    required: ['plan'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const plan = String(args.plan ?? '').trim();
    if (!plan) return err('plan cannot be empty');
    const runner = ctx.runner;
    if (!runner) return err('plan tool requires runner context');

    // No auto-approve shortcut: every plan, informational or not, pauses
    // for explicit user review. The previous /^no changes needed/ regex
    // was abused by the model as a fast-path to terminate runs without
    // ever pausing for the human, even for analysis/refactoring tasks
    // whose output IS the plan. Removing it costs an extra click on
    // trivial questions but eliminates the bypass entirely.

    const id = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // Persist the plan up-front so the dashboard's "Plans" tab shows it
    // even while still pending. The status is updated below once the
    // user responds.
    ctx.recordPlan?.(id, plan);
    runner.emit('plan_posted', { type: 'plan', id, plan });

    const raw = await runner.waitForUserInput();
    let parsed: { approved?: boolean; feedback?: string; aborted?: boolean };
    try { parsed = JSON.parse(raw); } catch { parsed = { approved: false, feedback: raw }; }

    if (parsed.aborted) {
      ctx.resolvePlan?.(id, 'aborted', parsed.feedback);
      return err('Plan review aborted by user.');
    }
    if (parsed.approved) {
      ctx.resolvePlan?.(id, 'approved', parsed.feedback);
      runner.approvePlan();
      return ok(formatPlanResult(true, parsed.feedback));
    }
    ctx.resolvePlan?.(id, 'rejected', parsed.feedback);
    return ok(formatPlanResult(false, parsed.feedback));
  },
};

export const planTools: CoderTool[] = [submitPlan];
