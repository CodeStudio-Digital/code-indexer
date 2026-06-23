/**
 * Failure-streak guard (PR 5).
 *
 * Closes the gap that let 13 consecutive `write_stdin` failures escape
 * every existing guard in session 798:
 *   - tuple-hash dedup keyed on full args ⇒ rotating `session_id`
 *     produced 13 unique keys.
 *   - doom-loop fuzzy required ALL last 6 sigs identical ⇒ no-tool
 *     turns between failures reset the window.
 *   - REPEATABLE_NAME_PATTERN doesn't match `write_stdin` (correctly).
 *   - quality watchdog has a long cooldown and doesn't distinguish
 *     `isError=true` from success.
 *
 * The unifying flaw was that `isError` was invisible to the loop
 * guards. `failure-streak` is the guard that uses it as the SOLE
 * signal: count per-tool, reset on success, escalate when the streak
 * crosses two configurable thresholds.
 *
 * Pure module: pulled in by `executing-dispatch.ts` after each tool
 * result returns. The state lives on `RunContext.failureStreaks` so it
 * survives across turns within a run; a fresh run starts empty.
 */

import {
  FAILURE_STREAK_REMINDER_THRESHOLD,
  FAILURE_STREAK_REFUSE_THRESHOLD,
  REPEATABLE_NAME_PATTERN,
} from '@mcp/code-agent/core/runner/constants.js';

/** One entry per tool name in the failure-streak table. */
export interface FailureStreakEntry {
  /** Consecutive `isError=true` results since the last success. */
  consecutive: number;
  /** Turn index of the FIRST failure in this streak. */
  firstFailureTurn: number;
  /** Turn index of the most recent failure in this streak. */
  lastFailureTurn: number;
  /**
   * First ~200 chars of the most recent error content. Surfaces in the
   * reminder / refusal text so the model sees what it was failing on
   * even after the original `tool_result` is elided by compaction.
   */
  lastError: string;
}

/** State container — keyed by tool name. Mutated in place. */
export interface FailureStreakState {
  streaks: Map<string, FailureStreakEntry>;
}

/**
 * Verdict returned by `checkFailureStreak`. Three shapes:
 *   - `pass`     → no intervention; let the result through unchanged.
 *   - `reminder` → prepend a sharp marker to the result content; the
 *                  model still sees the underlying error.
 *   - `refuse`   → replace content with a refusal; caller MUST flip
 *                  `isError=true` and emit ToolLoopDetected.
 */
export type FailureStreakVerdict =
  | { kind: 'pass' }
  | {
      kind: 'reminder';
      count: number;
      firstFailureTurn: number;
      lastError: string;
    }
  | {
      kind: 'refuse';
      count: number;
      firstFailureTurn: number;
      lastError: string;
    };

export interface CheckFailureStreakInput {
  toolName: string;
  isError: boolean;
  /** Raw tool result content. Truncated by the guard before storage. */
  errorContent: string;
  turn: number;
  state: FailureStreakState;
  /**
   * Override for the reminder threshold. Production callers always omit;
   * tests use it to keep fixtures small. Default
   * `FAILURE_STREAK_REMINDER_THRESHOLD`.
   */
  reminderThreshold?: number;
  /**
   * Override for the refuse threshold. Default
   * `FAILURE_STREAK_REFUSE_THRESHOLD`.
   */
  refuseThreshold?: number;
}

const ERROR_SNIPPET_CHARS = 200;

/**
 * Test whether a tool is exempt from the failure-streak guard. Polling
 * primitives (matching `REPEATABLE_NAME_PATTERN`) legitimately produce
 * a string of "no progress yet" results — counting those as a loop
 * would force-Plan over a healthy wait.
 *
 * Exported so callers can short-circuit storage (no entry created at
 * all for exempt tools).
 */
export function isFailureStreakExempt(toolName: string): boolean {
  return REPEATABLE_NAME_PATTERN.test(toolName);
}

/**
 * Core decision. Mutates `inp.state.streaks` in place.
 *
 * Contract:
 *   - `isError=false` → delete the streak entry for `toolName`, return
 *     `pass`. A single success clears the chain.
 *   - `isError=true` AND `toolName` is exempt → return `pass` without
 *     touching state.
 *   - `isError=true` otherwise → increment the entry (creating it if
 *     absent), then return `refuse` / `reminder` / `pass` based on the
 *     thresholds.
 */
export function checkFailureStreak(inp: CheckFailureStreakInput): FailureStreakVerdict {
  // Success path — clear and exit. Even an exempt tool's success is a
  // signal worth recording (in case the same tool later starts failing
  // outside the exempt window).
  if (!inp.isError) {
    inp.state.streaks.delete(inp.toolName);
    return { kind: 'pass' };
  }

  // Exempt path — polling tools are allowed long failure chains.
  if (isFailureStreakExempt(inp.toolName)) {
    return { kind: 'pass' };
  }

  const reminderThreshold = inp.reminderThreshold ?? FAILURE_STREAK_REMINDER_THRESHOLD;
  const refuseThreshold = inp.refuseThreshold ?? FAILURE_STREAK_REFUSE_THRESHOLD;

  const prev = inp.state.streaks.get(inp.toolName);
  const consecutive = (prev?.consecutive ?? 0) + 1;
  const firstFailureTurn = prev?.firstFailureTurn ?? inp.turn;
  const lastError = (inp.errorContent ?? '').slice(0, ERROR_SNIPPET_CHARS);
  inp.state.streaks.set(inp.toolName, {
    consecutive,
    firstFailureTurn,
    lastFailureTurn: inp.turn,
    lastError,
  });

  // Refuse takes precedence over reminder. The first time we cross the
  // refuse threshold the BT also routes to Planning (see dispatch).
  if (refuseThreshold > 0 && consecutive >= refuseThreshold) {
    return { kind: 'refuse', count: consecutive, firstFailureTurn, lastError };
  }
  if (reminderThreshold > 0 && consecutive >= reminderThreshold) {
    return { kind: 'reminder', count: consecutive, firstFailureTurn, lastError };
  }
  return { kind: 'pass' };
}

/**
 * Compose the marker prepended to a tool result when the streak crosses
 * the reminder threshold. The underlying `tool_result.content` still
 * follows — the model gets BOTH the marker and the raw error so it can
 * decide whether the situation is actually new.
 */
export function buildFailureStreakReminderMarker(verdict: {
  count: number;
  firstFailureTurn: number;
  lastError: string;
} & { toolName: string }): string {
  return (
    `[failure-streak: \`${verdict.toolName}\` has now failed ${verdict.count} ` +
    `times in a row (first failure at turn ${verdict.firstFailureTurn}). ` +
    `Re-read the error message below — repeating the same call with rotating ` +
    `arguments will NOT help. Consider: listing the active state, switching to ` +
    `a different tool, or asking the user via ask_user.]`
  );
}

/**
 * Refusal payload that REPLACES the tool result content when the
 * streak crosses the refuse threshold. Caller MUST flip `isError=true`
 * and emit ToolLoopDetected so the orchestrator transitions to Planning.
 */
export function buildFailureStreakRefusalText(verdict: {
  count: number;
  firstFailureTurn: number;
  lastError: string;
} & { toolName: string }): string {
  const errExcerpt = verdict.lastError
    ? `\nLast error: ${verdict.lastError}`
    : '';
  return (
    `[failure-streak REFUSED: tool \`${verdict.toolName}\` has failed ` +
    `${verdict.count} times consecutively (turns ${verdict.firstFailureTurn}…now). ` +
    `Refusing this dispatch and forcing a planning turn so the model can ` +
    `change approach.${errExcerpt}\n` +
    `Next steps: STOP retrying \`${verdict.toolName}\`. Either list available ` +
    `state (e.g. \`list_sessions\` for write_stdin failures), pick a different ` +
    `tool, or ask the user to clarify what they want next.]`
  );
}

/** Factory for the initial state attached to a new RunContext. */
export function emptyFailureStreakState(): FailureStreakState {
  return { streaks: new Map() };
}
