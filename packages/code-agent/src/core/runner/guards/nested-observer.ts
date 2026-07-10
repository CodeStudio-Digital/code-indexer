/**
 * Loop-guard observer for NESTED tool calls (code_exec scripts).
 *
 * `registry.invoke` is the shared chokepoint for arg-alias repair, but the
 * loop guards (tuple-hash dedup, failure-streak) live in the dispatch
 * pipeline — so calls made INSIDE a code_exec script historically bypassed
 * all of them: a script varied by one character could re-run the exact same
 * failing work forever, and a tool already refuse-thresholded at top level
 * could be hammered again from inside a script.
 *
 * This observer closes that hole WITHOUT moving guard state into the
 * registry (which is stateless and shared by design): the Executing node
 * builds one observer per code_exec call, closing over the run's own
 * `dupCalls` / `failureStreaks` maps, and code_exec consults it around each
 * nested invocation. Sharing state with the top level is intentional —
 * nested and direct calls count against the SAME streaks and dedup table,
 * and the Planning-turn reset clears both together.
 *
 * Differences from top-level dispatch, on purpose:
 *  - `allow-with-reminder` is treated as ALLOW: scripts parse tool output
 *    (JSON.parse), so prepending a marker would corrupt it. Only the hard
 *    refuse changes behavior, and it surfaces as a catchable JS exception.
 *  - The failure-streak check runs as a PRE-check against the current
 *    streak (top level enforces post-result): inside a script there is no
 *    later dispatch boundary to refuse at, so the refusal must come before
 *    re-running a tool that already crossed the threshold.
 *
 * Kill switch: `CODER_NESTED_GUARDS_DISABLE=1`.
 */
import { checkDupCall } from './tuple-hash-dedup.js';
import {
  checkFailureStreak,
  buildFailureStreakRefusalText,
  isFailureStreakExempt,
  type FailureStreakState,
} from './failure-streak.js';
import { FAILURE_STREAK_REFUSE_THRESHOLD } from '@mcp/code-agent/core/runner/constants.js';
import type { DupCallEntry } from '../machine/types.js';
import type { NestedToolObserver, NestedToolCallRecord } from '@mcp/code-agent/core/tool.js';

export function nestedGuardsEnabled(): boolean {
  return process.env.CODER_NESTED_GUARDS_DISABLE !== '1';
}

/** Preview cap for telemetry records — full outputs stay in the script. */
const RESULT_PREVIEW_CHARS = 2_000;

export interface NestedObserverDeps {
  /** The run's dedup table (`ctx.dupCalls`) — SHARED with top-level dispatch. */
  dupCalls: Map<string, DupCallEntry>;
  /** The run's failure-streak state (`ctx.failureStreaks`) — also shared. */
  failureStreaks: FailureStreakState;
  /** Turn the parent code_exec was dispatched on. */
  turn: number;
  /** tool_use id of the parent code_exec block. */
  parentToolUseId: string;
  /** Telemetry sink (PR nested-telemetry); absent = guards only. */
  onNestedCall?: (e: NestedToolCallRecord) => void;
}

export function buildNestedToolObserver(deps: NestedObserverDeps): NestedToolObserver {
  // Distinct counters: `beforeSeq` feeds dedup useIds (incremented per
  // attempt), `recordSeq` feeds telemetry ids (incremented per recorded
  // outcome). Scripts can run calls concurrently (Promise.all), so pairing
  // by a single counter would misattribute records.
  let beforeSeq = 0;
  let recordSeq = 0;

  return {
    beforeNestedCall(name, args, opts) {
      try {
        // Failure-streak pre-check: refuse re-running a tool whose streak
        // already crossed the refuse threshold (top level would have routed
        // to Planning; a script must not become the escape hatch).
        if (!isFailureStreakExempt(opts?.repeatable === true)) {
          const entry = deps.failureStreaks.streaks.get(name);
          if (entry && entry.consecutive >= FAILURE_STREAK_REFUSE_THRESHOLD) {
            return {
              refusalText: buildFailureStreakRefusalText({
                toolName: name,
                count: entry.consecutive,
                firstFailureTurn: entry.firstFailureTurn,
                lastError: entry.lastError,
              }),
              kind: 'failure-streak',
            };
          }
        }

        beforeSeq += 1;
        const verdict = checkDupCall({
          name,
          input: args,
          isRepeatable: !!opts?.repeatable,
          turn: deps.turn,
          useId: `${deps.parentToolUseId}#${beforeSeq}`,
          dupCalls: deps.dupCalls,
        });
        if (verdict.kind === 'refuse') {
          return { refusalText: verdict.refuseText, kind: 'dedup' };
        }
        // 'allow-with-reminder' → allow (see module docstring).
        return null;
      } catch {
        // A guard malfunction must never break a running script.
        return null;
      }
    },

    afterNestedCall(e) {
      try {
        // Feed the SHARED failure-streak state: a success clears the tool's
        // streak, a failure increments it. The verdict itself is ignored —
        // enforcement happens on the NEXT attempt via the pre-check above
        // (a result that already reached the script can't be un-delivered).
        if (e.affectsFailureStreak !== false) {
          checkFailureStreak({
            toolName: e.name,
            isError: e.isError,
            errorContent: e.resultPreview,
            turn: deps.turn,
            state: deps.failureStreaks,
            isRepeatable: e.repeatable === true,
          });
        }
      } catch { /* never throw into the script */ }
      try {
        recordSeq += 1;
        deps.onNestedCall?.({
          ...e,
          parentToolUseId: deps.parentToolUseId,
          seq: recordSeq,
          resultPreview: e.resultPreview.slice(0, RESULT_PREVIEW_CHARS),
        });
      } catch { /* telemetry must never break tool flow */ }
    },
  };
}
