/** One reminder for a Plan deliverable when the model ends with prose and review is available. */
import { classifyIntent } from '../../../agents/task-intent.js';
import { latestUserTaskText } from '../memory-query.js';
import type { RunContext } from '../machine/types.js';
import { planSubmissionGuidance } from '../../system-prompt.js';

/**
 * Decide whether a text-only finish in plan mode should be intercepted with a
 * mandatory-plan nudge. Returns the reminder text to inject (and bumps
 * `ctx.planNudges`) or null to let the run finish normally.
 *
 * Fires only when: plan mode is active, the user has NOT approved a plan in
 * this run, and we have not already nudged. A pending plan can't reach here —
 * `submit_plan` blocks the turn on user input — so `!planApproved` at a
 * text-only end means no plan was ever delivered.
 */
export function maybePlanNudge(ctx: RunContext): string | null {
  if (!ctx.opts.planMode || ctx.opts.specMode) return null;
  if (ctx.planNudges >= 1) return null;
  // No accessor wired (tests / subagents) → don't gate.
  const approved = ctx.bridge?.isPlanApproved?.();
  if (approved !== false) return null;
  const routes = planSubmissionGuidance(ctx.lastProviderToolNames);
  if (!routes) return null;

  // A clearly informational request can finish in a single provider call. Keep the
  // fallback for ambiguous requests and explicit plans, even when phrased as questions.
  const task = latestUserTaskText(ctx.messages);
  const intent = classifyIntent(task);
  if (intent.intent === 'answer' && intent.matched.length > 0 && !/\b(plan(?:s|ning|o|os)?|planej\w*)\b/i.test(task)) return null;
  ctx.planNudges += 1;
  return `<system-reminder>If the request needs a plan, submit it for review. ${routes} A factual or conversational answer can finish directly.</system-reminder>`;
}
