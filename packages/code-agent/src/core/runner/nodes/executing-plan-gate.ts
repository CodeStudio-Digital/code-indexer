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
 * A1 — independent goal-completion gate for `update_goal`.
 *
 * The verifier runs BEFORE the tool handler persists status=complete. A
 * negative verdict therefore leaves the durable goal in_progress, matching a
 * Stop-hook contract: only verified completion commits the terminal state.
 *
 * Fail-open by construction: unset callback, a thrown verifier, or a null
 * verdict (no usable persisted goal) lets the normal update proceed.
 * Negative verdicts are fail-closed and bounded: once the attempt cap is
 * reached, later calls are refused without spending another verifier request.
 */
const GOAL_VERIFY_MAX_ATTEMPTS = Math.max(0, Number(process.env.CODER_GOAL_VERIFY_MAX_ATTEMPTS ?? 2));

export async function maybeGoalCompletionRefusal(
  ctx: RunContext,
  evidence?: import('./executing-verification-gate.js').VerificationReadiness,
): Promise<string | null> {
  const verify = ctx.bridge?.verifyGoalCompletion;
  if (!verify) return null;
  let goal: ReturnType<NonNullable<typeof ctx.opts.toolContext.getGoalState>>;
  try {
    goal = ctx.opts.toolContext.getGoalState?.() ?? null;
  } catch {
    return null; // the lifecycle/persistence gate surfaces the authoritative error
  }
  if (goal?.status !== 'in_progress') return null;
  const evidenceFingerprint = evidence
    ? JSON.stringify({
        status: evidence.status,
        changedFiles: [...evidence.changedFiles].sort(),
        lastWriteSeq: evidence.lastWriteSeq,
        lastValidationSeq: evidence.lastValidationSeq,
        lastSuccessfulValidationSeq: evidence.lastSuccessfulValidationSeq,
        validationSignals: [...evidence.validationSignals].sort(),
      })
    : null;
  if (
    evidenceFingerprint != null
    && ctx.goalVerifyEvidenceFingerprint != null
    && evidenceFingerprint !== ctx.goalVerifyEvidenceFingerprint
  ) {
    // A new write/validation revision is real progress. Give the independent
    // verifier a fresh bounded budget instead of permanently pinning an old
    // negative verdict to the run.
    ctx.goalVerifyAttempts = 0;
  }
  if (evidenceFingerprint != null) {
    ctx.goalVerifyEvidenceFingerprint = evidenceFingerprint;
  }
  if (ctx.goalVerifyAttempts >= GOAL_VERIFY_MAX_ATTEMPTS) {
    return (
      '[goal-verifier] Refused `update_goal`: the independent completion check ' +
      `already found unmet requirements ${ctx.goalVerifyAttempts} time(s). ` +
      'The goal remains in_progress; address the reported gaps or stop with an explicit blocker.'
    );
  }

  let verdict: { goalMet: boolean; gaps: ReadonlyArray<{ description: string; severity: string }> } | null;
  try {
    verdict = await verify(evidence);
  } catch {
    return null; // fail-open — a broken verifier must never block the run
  }
  if (!verdict) return null;
  if (verdict.goalMet) return null;

  ctx.goalVerifyAttempts += 1;
  const gapLines = verdict.gaps.length
    ? verdict.gaps.map((g) => `- [${g.severity}] ${g.description}`).join('\n')
    : '- (no specific gaps returned — re-check the goal against your changes)';
  return (
    '[goal-verifier] Refused `update_goal`: an independent completion check found the goal is NOT fully met. ' +
    'The persisted goal remains in_progress. Address these gaps, then retry:\n' +
    gapLines +
    `\nIf a gap is wrong or genuinely out of scope, state that explicitly rather than silently ignoring it. ` +
    `The verifier runs at most ${GOAL_VERIFY_MAX_ATTEMPTS} time(s) per run.`
  );
}
