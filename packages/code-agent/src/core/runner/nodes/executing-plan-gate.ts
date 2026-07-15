/**
 * Mandatory-plan gate for the Executing node.
 *
 * In plan mode the deliverable IS a plan: the run must not end with a bare
 * text turn ("switch to build to execute") without ever calling
 * `submit_plan` / `submit_tasks`. When a text-only turn is about to finish the
 * run while plan mode is active and no plan was approved, this returns a
 * one-shot `<system-reminder>` nudging the model to submit a real plan; the
 * Executing node injects it as the next user message and re-enters the turn.
 *
 * Bounded at ONE nudge per run (`ctx.planNudges`) so a genuinely
 * conversational reply (greeting / trivial Q&A) still terminates right after
 * the nudge instead of looping. Kept out of `executing.ts` (already large),
 * mirroring the `executing-self-review.ts` sub-module pattern.
 */
import type { RunContext } from '../machine/types.js';

const PLAN_NUDGE_TEXT =
  '<system-reminder>Plan mode is active and you ended without delivering a plan. ' +
  'Your deliverable is a real plan: call `submit_plan` (or `submit_tasks` for ' +
  'multi-part work) so the user can approve it — do NOT end with prose like ' +
  '"switch to build to execute". If your last reply was purely conversational ' +
  '(a greeting or a one-line factual answer that needs no workspace changes), ' +
  'you may finish now.</system-reminder>';

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
  if (!ctx.opts.planMode) return null;
  if (ctx.planNudges >= 1) return null;
  // No accessor wired (tests / subagents) → don't gate.
  const approved = ctx.bridge?.isPlanApproved?.();
  if (approved !== false) return null;
  ctx.planNudges += 1;
  return PLAN_NUDGE_TEXT;
}

/**
 * A1 — goal-completion gate for a text-only finish (the "stop-condition
 * verifier" half of Claude Code's two-agent split).
 *
 * When the host wired `bridge.verifyGoalCompletion` (CODER_GOAL_VERIFY on), a
 * text-only turn that would end the run first asks an INDEPENDENT read-only
 * verifier subagent whether the original goal is actually met. A 'not met'
 * verdict returns a `<system-reminder>` listing the gaps (the Executing node
 * injects it and re-enters); a 'met' verdict (or no verdict at all) lets the
 * run finish.
 *
 * Fail-open by construction: unset callback, a thrown verifier, or a null
 * verdict (no active goal / no pending diff) all return null so the run is
 * NEVER blocked by the verifier itself. Bounded by
 * `CODER_GOAL_VERIFY_MAX_ATTEMPTS` (default 2) — the cap is checked BEFORE the
 * (expensive) verifier call so a stubborn verdict can't loop or keep spending.
 */
const GOAL_VERIFY_MAX_ATTEMPTS = Math.max(0, Number(process.env.CODER_GOAL_VERIFY_MAX_ATTEMPTS ?? 2));

export async function maybeGoalVerifyNudge(ctx: RunContext): Promise<string | null> {
  const verify = ctx.bridge?.verifyGoalCompletion;
  if (!verify) return null; // disabled / not wired (subagents, tests)
  if (ctx.goalVerifyAttempts >= GOAL_VERIFY_MAX_ATTEMPTS) return null; // bounded — don't even spend the call

  let verdict: { goalMet: boolean; gaps: ReadonlyArray<{ description: string; severity: string }> } | null;
  try {
    verdict = await verify();
  } catch {
    return null; // fail-open — a broken verifier must never block the run
  }
  if (!verdict) return null; // not applicable (no goal / no diff) or host-disabled
  if (verdict.goalMet) return null; // goal met → let the run finish

  ctx.goalVerifyAttempts += 1;
  const gapLines = verdict.gaps.length
    ? verdict.gaps.map((g) => `- [${g.severity}] ${g.description}`).join('\n')
    : '- (no specific gaps returned — re-check the goal against your changes)';
  return (
    '<system-reminder>An independent completion check found the goal is NOT fully met yet. ' +
    'Address these gaps, then continue toward done:\n' +
    gapLines +
    `\nIf a gap is wrong or genuinely out of scope, say so explicitly in your final summary instead of silently ignoring it. ` +
    `This check runs at most ${GOAL_VERIFY_MAX_ATTEMPTS} time(s) per run.</system-reminder>`
  );
}
