/**
 * Module-level product constants and small helpers for the runner's
 * loop-guard family. Attempt-scoped configuration lives in RuntimePolicy;
 * these safety ceilings intentionally have no process-wide override.
 *
 * Owns: doom-loop / dominance / failure-streak / polling / summarizer /
 * push-time-cap / per-turn budget knobs.
 */

/**
 * Unrestricted-mode push-time caps. When the per-session
 * `unrestrictedToolOutput` toggle is on, the runner bumps the
 * effective per-tool-result cap to these ceilings instead of the
 * default tunables. Auto-compaction still fires, so very large
 * outputs (Unity console dumps, MCP search hits) arrive intact in
 * the turn that produced them.
 */
export const UNRESTRICTED_PUSH_TIME_CAP = 1_000_000;
export const UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP = 500_000;

/** Per-turn safety budget — emits a warning when the about-to-send payload exceeds this. */
export const TURN_BUDGET_CHARS = 30_000;

/**
 * Dominance guard (`guards/dominance.ts`). Catches one tool eating a long
 * window of turns with ZERO assistant text — the silent-grind runaway
 * (session 609: 50+ turns of `mcp__read_file`, no narration). Lazy readers so
 * Uses the telemetry-proven product posture; it is not deployment config.
 *
 *   - window: 8 turns inspected.
 *   - ratio:  one tool owns at least 75% of the window.
 */
export function dominanceWindow(): number {
  return 8;
}
export function dominanceRatio(): number {
  return 0.75;
}

/**
 * Polling-result stuck cap. Even legitimate polling SHOULD see state
 * evolve. When the RESULT content is byte-identical for N polls in a
 * row, the polling is stuck and the agent is wasting tokens.
 */
export const POLLING_STUCK_CAP = 10;
export const POLLING_STUCK_MIN_CHARS = 50;

/**
 * PR 5 (failure-streak guard) — per-tool consecutive-failure counters.
 *
 * Gap caught in session 798: 13 `write_stdin` calls failed in 0ms each
 * because the LLM rotated `session_id` between calls. Tuple-hash dedup
 * saw 13 unique keys, doom-loop-fuzzy got reset by intercalated no-tool
 * turns, and `isError=true` was invisible to every existing guard.
 *
 * `failure-streak` counts consecutive `isError=true` results per tool
 * name. Threshold `REMINDER` prepends a sharp marker to the next result
 * ("you've failed N×; LIST sessions / RE-READ the error / change tactic").
 * Threshold `REFUSE` replaces the result with a hard refusal and emits
 * `ToolLoopDetected{guard:'failure-streak'}` so the BT routes to
 * Planning. A single successful call resets the streak.
 *
 * Tools resolved to repeatPolicy=pollable are exempt — for polling
 * primitives a string of empty results is the workflow, not a loop. Volatile
 * calls still use the ordinary failure-streak protection.
 */
export const FAILURE_STREAK_REMINDER_THRESHOLD = 3;
export const FAILURE_STREAK_REFUSE_THRESHOLD = 5;

/**
 * Phase B — summarizer pass cap + cooldown. Up to `MAX_RUNS` LLM
 * summarizer passes per session with at least `COOLDOWN_TURNS` between
 * consecutive passes. MAX_RUNS=1 restores legacy lock-once; MAX_RUNS=0
 * disables the summarizer entirely.
 */
export const SUMMARIZER_MAX_RUNS = 6;
export const SUMMARIZER_COOLDOWN_TURNS = 8;

/**
 * Pure helper exported for testability. Returns true when the LLM
 * summarizer is allowed to run on this turn given the per-session
 * count + cooldown budget.
 *
 * Rules:
 *   - `maxRuns <= 0` disables the summarizer entirely (returns false).
 *   - The first eligible run (runCount === 0) always passes the
 *     cooldown — `lastTurn` is `-Infinity` initially.
 *   - Subsequent runs require `turn - lastTurn >= cooldownTurns`.
 */
export function canRunSummarizer(args: {
  runCount: number;
  lastTurn: number;
  currentTurn: number;
  maxRuns: number;
  cooldownTurns: number;
}): boolean {
  if (args.maxRuns <= 0) return false;
  if (args.runCount >= args.maxRuns) return false;
  if (args.runCount === 0) return true;
  return args.currentTurn - args.lastTurn >= args.cooldownTurns;
}
