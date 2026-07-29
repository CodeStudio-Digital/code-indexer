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
 * Schedule the independent completion reviewer after goal persistence.
 *
 * The reviewer is deliberately detached from dispatch: its positive,
 * negative, inconclusive, or failed result is audit data only. It can improve
 * later diagnosis without delaying the tool result or revoking completion.
 */
export function scheduleGoalCompletionAdvisory(
  ctx: RunContext,
  evidence?: import('./executing-verification-gate.js').VerificationReadiness,
): boolean {
  const verify = ctx.bridge?.verifyGoalCompletion;
  if (!verify) return false;

  const record = (
    health: 'verified' | 'unverified' | 'completed_with_warnings',
    content: string,
    gaps: ReadonlyArray<{ description: string; severity: string }> = [],
  ): void => {
    if (ctx.opts.sessionId == null) return;
    try {
      ctx.opts.sessionStore?.recordSessionInput({
        session_id: ctx.opts.sessionId,
        kind: 'system_reminder',
        source_label: 'advisory:goal-verification',
        content,
        meta: {
          health,
          gaps,
          evidence_status: evidence?.status ?? null,
          validation_signals: evidence?.validationSignals ?? [],
          turn: ctx.turn,
        },
      });
    } catch {
      // Audit persistence is best-effort and must not affect the completed run.
    }
  };

  queueMicrotask(() => {
    void verify(evidence).then((verdict) => {
      if (!verdict) {
        record(
          'unverified',
          '[goal-advisory] Independent completion review was inconclusive. The goal remains complete.',
        );
        return;
      }
      if (verdict.goalMet) {
        record(
          'verified',
          '[goal-advisory] Independent completion review confirmed the completed goal.',
        );
        return;
      }
      const gapLines = verdict.gaps.length > 0
        ? verdict.gaps.map((gap) => `- [${gap.severity}] ${gap.description}`).join('\n')
        : '- No specific gaps were returned.';
      record(
        'completed_with_warnings',
        '[goal-advisory] Independent completion review reported gaps after completion:\n' + gapLines,
        verdict.gaps,
      );
    }).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      record(
        'unverified',
        `[goal-advisory] Independent completion review failed (${reason}). The goal remains complete.`,
      );
    });
  });
  return true;
}
