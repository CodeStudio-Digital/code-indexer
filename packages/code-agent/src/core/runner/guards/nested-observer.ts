/**
 * Loop-guard observer for tool calls made inside one `code_exec` invocation.
 *
 * Duplicate-call state is deliberately LOCAL to this observer. Production
 * creates one observer per parent `code_exec`, so a read performed in an
 * earlier turn/script cannot poison a later batch. Stable reads are reused by
 * `code-exec.ts`; this observer records repetition without refusing execution.
 * Cross-turn no-progress detection belongs to the runner's result-aware
 * tracker, not to this pre-dispatch hook.
 *
 * The run-wide failure-streak table remains shared. It is result-aware and is
 * still useful across direct/nested calls; policy and permission denials are
 * recorded with `affectsFailureStreak=false` by the caller.
 *
 * Permissions, execution timeouts and uncertain-operation protection are
 * enforced independently by code_exec.
 */
import {
  checkFailureStreak,
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
import type { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';
import type {
  NestedToolObserver,
  NestedToolCallRecord,
} from '@mcp/code-agent/core/tool.js';

export function nestedGuardsEnabled(): boolean {
  return true;
}

/** Preview cap for telemetry records — full outputs stay in the script. */
const RESULT_PREVIEW_CHARS = 2_000;

export interface NestedObserverDeps {
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
  toolCallLedger?: ToolCallLedger;
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
        if (!(opts?.failureStreakExempt ?? repeatPolicy === 'pollable')) {
          const entry = deps.failureStreaks.streaks.get(name);
          if (entry && entry.consecutive >= FAILURE_STREAK_REFUSE_THRESHOLD) {
            return {
              action: 'shadow',
              reason: 'failure-streak',
              shouldReflect: false,
              affectsFailureStreak: false,
              count: entry.consecutive,
              sourceTool: name,
              originToolUseId: attemptId,
              ...(opts?.stateEpoch !== undefined ? { stateEpoch: opts.stateEpoch } : {}),
            };
          }
        }

        const noProgress = deps.toolCallLedger?.checkRepeat({
          name,
          args,
          repeatPolicy,
          mutates: repeatPolicy === 'mutating',
        });
        if (noProgress) {
          return {
            action: 'shadow',
            reason: 'cross-turn-no-progress',
            shouldReflect: false,
            affectsFailureStreak: false,
            count: noProgress.count,
            sourceTool: name,
            originToolUseId: attemptId,
          };
        }

        const dedup = checkDupCall({
          name,
          input: args,
          normalizedInput: args,
          repeatPolicy,
          turn: deps.turn,
          useId: attemptId,
          invocationState: local,
          forceReread: opts?.forceReread,
        });
        if (dedup.action === 'allow') return null;
        return {
          action: 'shadow', reason: 'repeated-invocation', shouldReflect: false,
          affectsFailureStreak: true, count: dedup.count,
          sourceTool: name, originToolUseId: attemptId, stateEpoch: dedup.stateEpoch,
        };
      } catch {
        // A guard malfunction must never break a running script.
        return null;
      }
    },

    afterNestedCall(e) {
      // code_exec records the authoritative result before notifying this
      // observer and supplies its logicalOperationId. Other nested producers
      // may not, so retain the fallback record only when no prior ledger
      // identity exists.
      const ledgerEntry = e.logicalOperationId
        ? undefined
        : deps.toolCallLedger?.record({
            name: e.name,
            args: e.args,
            content: e.resultPreview,
            isError: e.isError,
            refusalKind: e.refusalKind,
            mutates:
              e.repeatPolicy === 'mutating'
              || e.executionClass === 'write'
              || e.executionClass === 'execute',
            durationMs: e.durationMs,
            executionClass: e.executionClass,
            repeatPolicy: e.repeatPolicy,
          });
      try {
        // A successful different write/execute establishes a new local state
        // epoch. Preserve its own diagnostic counter and clear stale counters.
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
            isRepeatable: e.failureStreakExempt ?? e.repeatPolicy === 'pollable',
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
          resultNovel: ledgerEntry?.resultNovel ?? e.resultNovel,
          coverageNovel: ledgerEntry?.coverageNovel ?? e.coverageNovel,
          productive: ledgerEntry?.productive ?? e.productive,
          stateEpoch: deps.noProgressTracker.stateEpoch,
        }) ?? null;
        deps.onNestedCall?.({
          ...e,
          logicalOperationId: ledgerEntry?.logicalOperationId ?? e.logicalOperationId,
          resultNovel: ledgerEntry?.resultNovel ?? e.resultNovel,
          coverageNovel: ledgerEntry?.coverageNovel ?? e.coverageNovel,
          productive: ledgerEntry?.productive ?? e.productive,
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
