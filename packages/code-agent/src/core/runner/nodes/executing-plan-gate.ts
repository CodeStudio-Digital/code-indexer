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
  /\boption\s+[a-d]\b|\bapproach\s+[12]\b|\btwo (?:viable )?approaches?\b|\balternativ|\bcould either\b|\bon the other hand\b|\beither\b[^.\n]{0,80}\bor\b/i;

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
