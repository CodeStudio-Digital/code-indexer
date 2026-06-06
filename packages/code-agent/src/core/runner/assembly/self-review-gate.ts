/**
 * self_review nudge gate (Fix A).
 *
 * The dynamic-injection nudge ("call `self_review` before telling the user
 * it's done") is recomputed every turn while the session has pending
 * snapshots. But `self_review` is read-only and NEVER closes those snapshots,
 * so `hasReviewableChanges` stays true forever — the agent re-reviews, applies
 * findings (which create MORE pending changes), and re-reviews again, looping
 * until it ignores even an explicit user "stop". Observed in session 887:
 * ~15 `self_review` calls in a row, continuing past goal completion, and the
 * agent doing `self_review` again right after the user said "finalize sem
 * self_review".
 *
 * This module decides whether the nudge SHOULD fire this turn, from signals
 * the runner reads off the snapshot + review stores:
 *   1. respect an explicit hard-stop (user declined / cap hit),
 *   2. nudge only when there are pending changes,
 *   3. hard-stop after K total auto-reviews this session,
 *   4. CORE: don't nudge when the pending changes were already reviewed and
 *      nothing was edited since,
 *   5. nudge once per distinct pending state (fingerprint).
 *
 * Pure + deterministic — unit-tested in `__tests__/self-review-gate.test.ts`.
 */

export interface SelfReviewSignals {
  /** `${activeBaselineCount}:${maxLastEditedAtMs}`; '' when no active snapshots. */
  pendingFingerprint: string;
  /** ms-epoch of the newest active snapshot edit, or null when none. */
  lastEditAt: number | null;
  /** ms-epoch of the most recent completed auto self_review, or null. */
  lastReviewAt: number | null;
  /** total completed auto self_reviews this session (drives the hard-stop). */
  totalAutoReviews: number;
}

export interface SelfReviewGateState {
  /** Pending fingerprint last nudged — re-nudge only when it changes. */
  lastNudgedFingerprint?: string;
  /** Latched off for the rest of the run (user declined / cap hit). */
  suppressed: boolean;
}

export interface SelfReviewGateOptions {
  /**
   * Hard-stop the nudge after this many total auto-reviews this session.
   * The `self_review` TOOL stays available — we just stop PUSHING it, which
   * is what amplifies the review→fix→review loop. `<= 0` disables the cap.
   */
  maxReviews: number;
}

/**
 * Decide whether to surface the self_review nudge this turn. Mutates `state`
 * only to latch `suppressed` when the hard-stop trips. The caller is
 * responsible for setting `state.lastNudgedFingerprint` when this returns true.
 */
export function shouldNudgeSelfReview(
  signals: SelfReviewSignals,
  state: SelfReviewGateState,
  opts: SelfReviewGateOptions,
): boolean {
  // 1. Already suppressed (user declined / cap hit) — stays off the whole run.
  if (state.suppressed) return false;
  // 2. Nothing pending to review.
  if (!signals.pendingFingerprint) return false;
  // 3. Session cap: the agent has reviewed enough; further reminders only
  //    amplify the loop. Latch off so it never comes back this run.
  if (opts.maxReviews > 0 && signals.totalAutoReviews >= opts.maxReviews) {
    state.suppressed = true;
    return false;
  }
  // 4. CORE FIX: the pending changes were already reviewed and nothing has
  //    been edited since — re-reviewing the same state is the doom-loop.
  if (
    signals.lastReviewAt != null &&
    signals.lastEditAt != null &&
    signals.lastEditAt <= signals.lastReviewAt
  ) {
    return false;
  }
  // 5. Already nudged for this exact pending state — nudge once per change.
  if (signals.pendingFingerprint === state.lastNudgedFingerprint) return false;
  // 6. Unreviewed changes — nudge (caller latches the fingerprint).
  return true;
}

/**
 * Detect an explicit user instruction to skip/stop self_review, so the caller
 * can latch `suppressed`. This is the structural fix for "the nudge overrides
 * the user" — session 887's "finalize os regressivos novamente sem
 * self_review" was ignored and the agent re-reviewed anyway.
 *
 * PT-BR + EN. Requires a skip/negation cue DIRECTLY tied to a review cue, so
 * normal mentions of "review" don't trip it. A false positive only stops an
 * optional reminder (the tool remains usable), so we lean toward catching.
 */
const REVIEW_CUE = String.raw`(?:self[\s_-]?review|revis\w*|reviews?)`;
const DECLINE_RE = new RegExp(
  [
    String.raw`sem\s+${REVIEW_CUE}`, // "sem self_review", "sem revisão"
    String.raw`n[ãa]o\s+\w+(?:\s+\w+){0,2}\s+${REVIEW_CUE}`, // "não rode (o) self_review", "não faça a revisão"
    String.raw`(?:pare|para|chega)\s+de\s+${REVIEW_CUE}`, // "pare de revisar", "chega de review"
    String.raw`(?:skip|stop|without|no\s+more|no)\s+(?:the\s+|a\s+|o\s+)?${REVIEW_CUE}`,
    String.raw`don'?t\s+(?:run|do|use)\s+(?:the\s+)?${REVIEW_CUE}`,
  ].join('|'),
);

export function isSelfReviewDecline(text: string): boolean {
  if (!text) return false;
  return DECLINE_RE.test(text.toLowerCase());
}
