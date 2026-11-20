/**
 * Module-level product constants and small helpers for the runner's
 * loop-guard family. Attempt-scoped configuration lives in RuntimePolicy;
 * these safety ceilings intentionally have no process-wide override.
 *
 * Owns: doom-loop / dominance / failure-streak / polling knobs.
 */

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
 * Threshold `REFUSE` is diagnostic too: direct dispatch reports it like a
 * reminder and the code_exec nested pre-check records a `shadow` verdict.
 * A single successful call resets the streak.
 *
 * Tools resolved to repeatPolicy=pollable are exempt — for polling
 * primitives a string of empty results is the workflow, not a loop. Volatile
 * calls still use the ordinary failure-streak protection.
 */
export const FAILURE_STREAK_REMINDER_THRESHOLD = 3;
export const FAILURE_STREAK_REFUSE_THRESHOLD = 5;
