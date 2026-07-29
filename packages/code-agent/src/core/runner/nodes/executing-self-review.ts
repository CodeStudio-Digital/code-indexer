/**
 * Fix A — self_review nudge glue for the Executing node.
 *
 * Keeps the ctx-coupled decision out of the (already large) executing.ts,
 * following the established `executing-*.ts` sub-module pattern. The pure rules
 * live in `../assembly/self-review-gate.ts`; this is only the wiring that reads
 * runner options + injection state.
 */
import type { RunContext } from '../machine/types.js';
import { shouldNudgeSelfReview, isSelfReviewDecline } from '../assembly/self-review-gate.js';
import { selfReviewMaxNudges } from '../constants.js';

/**
 * Latch the self_review nudge off when the user explicitly declines review
 * (session 887: "finalize ... sem self_review" was ignored). Idempotent and
 * cheap — safe to call every turn.
 */
export function applySelfReviewDecline(ctx: RunContext, userText: string): void {
  const sr = ctx.injectionState.selfReview;
  if (!sr.suppressed && isSelfReviewDecline(userText)) {
    sr.suppressed = true;
  }
}

/**
 * Decide whether to surface the self_review nudge this turn. Uses the rich
 * `collectSelfReviewSignals` (nudge only on UNREVIEWED changes, hard-stop after
 * a cap) so it can't re-fire every turn while the same pending changes sit
 * reviewed; falls back to the coarse `hasReviewableChanges` boolean on
 * subagents/tests that don't provide signals.
 */
export async function computeSelfReviewNudge(ctx: RunContext): Promise<boolean> {
  if (process.env.CODER_SELF_REVIEW === '0') return false;
  const sr = ctx.injectionState.selfReview;
  if (sr.suppressed) return false;
  const signals = await ctx.opts.collectSelfReviewSignals?.() ?? null;
  if (!signals) return (await ctx.opts.hasReviewableChanges?.()) ?? false;
  const nudge = shouldNudgeSelfReview(signals, sr, { maxReviews: selfReviewMaxNudges() });
  if (nudge) sr.lastNudgedFingerprint = signals.pendingFingerprint;
  return nudge;
}
