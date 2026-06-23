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
 * Soft-mandatory decision gate. Fired from the `submit_plan` handler BEFORE it
 * pauses for approval. Returns a one-shot tool_result nudge (string) telling the
 * model to consult the user on the fork via `decision_gate`, or null to let the
 * submission proceed. Returning an `err` from submit_plan (not a pause) keeps it
 * strictly one-shot and deadlock-free: the model reads it, runs `decision_gate`,
 * then re-submits — and the re-submit always goes through.
 *
 * Suppressed when: not in plan mode; disabled (`CODER_DECISION_GATE=off`);
 * depth is `simple` (trivial tasks rarely fork); the user was already consulted
 * this run (`decisionAsks >= 1`, set by decision_gate / option-backed ask_user);
 * or we already nudged once. Heuristic biased to FALSE NEGATIVES: it only fires
 * on multi-token fork phrasing ("two approaches", "option A", "either … or",
 * "on the other hand"), NOT on lone idioms ("instead of", "trade-offs", bare
 * "vs"/"either") that pepper ordinary single-approach plans — those produced a
 * wasted turn on most plans for no fork. A missed fork just means no nudge (the
 * prompt still asks the model to gate); a false nudge costs a turn, so we err
 * toward silence.
 */
const DECISION_FORK_RE =
  /\boption\s+[a-d]\b|\bapproach\s+[12]\b|\btwo (?:viable )?approaches?\b|\balternativ|\bcould either\b|\bon the other hand\b|\beither\b[^.\n]{0,40}\bor\b/i;

const DECISION_GATE_NUDGE_TEXT =
  'Hold on — this plan presents more than one viable approach, but you have not consulted the user on the fork. ' +
  'Call `decision_gate` to let the user choose among the alternatives (give each option a one-line summary and its tradeoffs), ' +
  'then call `submit_plan` again with the chosen approach and record it in the plan\'s Decisions section. ' +
  'Use `ask_user` instead for a single quick fork. If there is genuinely ONE defensible approach and the alternative wording is ' +
  'incidental, just call `submit_plan` again as-is and it will proceed — this check fires only once.';

export function maybeDecisionGateNudge(input: {
  planMode: boolean;
  planDepth: string;
  enabled: boolean;
  decisionAsks: number;
  decisionGateNudges: number;
  planText: string;
}): string | null {
  if (!input.planMode) return null;
  if (!input.enabled) return null;
  if (input.planDepth === 'simple') return null;
  if (input.decisionAsks >= 1) return null; // user already consulted this run
  if (input.decisionGateNudges >= 1) return null; // one-shot
  if (!DECISION_FORK_RE.test(input.planText)) return null;
  return DECISION_GATE_NUDGE_TEXT;
}
