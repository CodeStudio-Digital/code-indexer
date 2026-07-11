/**
 * Loop-guard observer for tool calls made inside one `code_exec` invocation.
 *
 * Duplicate-call state is deliberately LOCAL to this observer. Production
 * creates one observer per parent `code_exec`, so a read performed in an
 * earlier turn/script cannot poison a later batch. Stable reads are reused by
 * `code-exec.ts`; this observer only stops a tight loop of unsafe operations.
 * Cross-turn no-progress detection belongs to the runner's result-aware
 * tracker, not to this pre-dispatch hook.
 *
 * The run-wide failure-streak table remains shared. It is result-aware and is
 * still useful across direct/nested calls; policy and permission denials are
 * recorded with `affectsFailureStreak=false` by the caller.
 *
 * Kill switch: `CODER_NESTED_GUARDS_DISABLE=1`.
 */
import {
  checkFailureStreak,
  buildFailureStreakRefusalText,
  type FailureStreakState,
} from './failure-streak.js';
import { FAILURE_STREAK_REFUSE_THRESHOLD } from '@mcp/code-agent/core/runner/constants.js';
import {
  checkDupCall,
  createInvocationGuardState,
  invocationGuardKey,
  type InvocationGuardState,
} from './tuple-hash-dedup.js';
import type { NoProgressTracker } from './no-progress.js';
import type { DupCallEntry } from '../machine/types.js';
import type {
  NestedToolObserver,
  NestedToolCallRecord,
} from '@mcp/code-agent/core/tool.js';

export function nestedGuardsEnabled(): boolean {
  return process.env.CODER_NESTED_GUARDS_DISABLE !== '1';
}

/** Preview cap for telemetry records — full outputs stay in the script. */
const RESULT_PREVIEW_CHARS = 2_000;

export interface NestedObserverDeps {
  /**
   * Legacy construction input retained so existing factories do not need an
   * atomic migration. Hybrid/observe ignore it; explicit legacy mode uses it
   * as the rollback table.
   */
  dupCalls?: Map<string, DupCallEntry>;
  /** The run's failure-streak state — shared with direct dispatch. */
  failureStreaks: FailureStreakState;
  /** Turn the parent code_exec was dispatched on. */
  turn: number;
  /** tool_use id of the parent code_exec block. */
  parentToolUseId: string;
  /** Optional explicit local state, primarily useful for focused tests. */
  invocationState?: InvocationGuardState;
  /** Shared post-result tracker; its epoch advances on successful nested writes/executes. */
  noProgressTracker?: NoProgressTracker;
  /** Telemetry sink; absent = guards only. */
  onNestedCall?: (e: NestedToolCallRecord) => void;
}

export function buildNestedToolObserver(deps: NestedObserverDeps): NestedToolObserver {
  const local = deps.invocationState ?? createInvocationGuardState();
  let beforeSeq = 0;
  let recordSeq = 0;

  return {
    beforeNestedCall(name, args, opts) {
      try {
        const repeatPolicy = opts?.repeatPolicy ?? (opts?.repeatable ? 'pollable' : 'stable');
        beforeSeq += 1;
        const attemptId = opts?.originToolUseId ?? `${deps.parentToolUseId}#${beforeSeq}`;

        // force_reread is an explicit request for fresh data and bypasses every
        // cross-turn pre-check, including an old failure streak.
        if (opts?.forceReread) return null;

        // Pollable tools are exempt from failure streaks. Volatile tools are
        // not: their results may vary, but repeated hard failures still matter.
        if (repeatPolicy !== 'pollable') {
          const entry = deps.failureStreaks.streaks.get(name);
          if (entry && entry.consecutive >= FAILURE_STREAK_REFUSE_THRESHOLD) {
            const text = buildFailureStreakRefusalText({
              toolName: name,
              count: entry.consecutive,
              firstFailureTurn: entry.firstFailureTurn,
              lastError: entry.lastError,
            });
            return {
              action: 'block',
              reason: 'failure-streak',
              refusalKind: 'failure-streak',
              shouldReflect: true,
              affectsFailureStreak: false,
              count: entry.consecutive,
              sourceTool: name,
              originToolUseId: attemptId,
              ...(opts?.stateEpoch !== undefined ? { stateEpoch: opts.stateEpoch } : {}),
              refusalText: text,
              kind: 'failure-streak',
            };
          }
        }

        const dedup = checkDupCall({
          name,
          input: args,
          normalizedInput: args,
          repeatPolicy,
          turn: deps.turn,
          useId: attemptId,
          // Hybrid/observe use only the local state. The shared legacy table is
          // supplied solely when the explicit rollback mode is selected.
          dupCalls: deps.dupCalls,
          invocationState: local,
          forceReread: opts?.forceReread,
        });
        if (dedup.action === 'allow') return null;
        if (dedup.action === 'block') {
          return {
            ...dedup,
            refusalText: dedup.refuseText,
            kind: 'dedup',
          };
        }
        return dedup;
      } catch {
        // A guard malfunction must never break a running script.
        return null;
      }
    },

    afterNestedCall(e) {
      try {
        // A successful different write/execute establishes a new local state
        // epoch. Preserve the successful operation's own counter so repeating
        // the same unsafe action is still warned/blocked; clear all others.
        const changesState = e.repeatPolicy === 'mutating' ||
          e.executionClass === 'write' || e.executionClass === 'execute';
        if (!e.isError && changesState) {
          const successfulKey = invocationGuardKey(e.name, e.args);
          local.noteStateChange(successfulKey);
          deps.noProgressTracker?.noteStateChange();
        }

        if (e.affectsFailureStreak !== false) {
          checkFailureStreak({
            toolName: e.name,
            isError: e.isError,
            errorContent: e.resultPreview,
            turn: deps.turn,
            state: deps.failureStreaks,
            // Polling may legitimately return a long error/no-progress chain;
            // volatile calls keep ordinary failure-streak protection.
            isRepeatable: e.repeatPolicy === 'pollable',
          });
        }
      } catch { /* never throw into the script */ }
      try {
        recordSeq += 1;
        const noProgressVerdict = deps.noProgressTracker?.observe({
          name: e.name,
          normalizedInput: e.args,
          content: e.resultPreview,
          isError: e.isError,
          turn: deps.turn,
          toolUseId: `${deps.parentToolUseId}#${recordSeq}`,
          repeatPolicy: e.repeatPolicy ?? (e.repeatable ? 'pollable' : 'stable'),
          resultNovel: e.resultNovel,
          coverageNovel: e.coverageNovel,
          productive: e.productive,
          stateEpoch: deps.noProgressTracker.stateEpoch,
        }) ?? null;
        deps.onNestedCall?.({
          ...e,
          ...(e.guardVerdict || !noProgressVerdict ? {} : { guardVerdict: noProgressVerdict }),
          stateEpoch: deps.noProgressTracker?.stateEpoch ?? e.stateEpoch,
          parentToolUseId: deps.parentToolUseId,
          seq: recordSeq,
          resultPreview: e.resultPreview.slice(0, RESULT_PREVIEW_CHARS),
        });
      } catch { /* telemetry must never break tool flow */ }
    },
  };
}
