/**
 * Wire HumanInTheLoop + meta-bus listeners onto the master's runner.
 *
 * Two functions:
 *   - `wireMasterRunnerListeners` — runs via `runCoder({ onRunnerReady })`
 *     BEFORE the runner takes its first turn, so an `ask_user` made on
 *     turn 1 still gets captured.
 *   - `attachMasterCompletionHandler` — wraps `handle.done` with the
 *     status persistence, board posting, and idle-controller notify
 *     that need to fire on EVERY exit path (completed / errored / aborted).
 *
 * Extracted from `MasterLifecycle.wireAllForRunner` /
 * `attachCompletionHandler` so the wiring contract is one focused file
 * and the master class body shrinks to its state-management role.
 *
 * Both helpers take a `MasterRunnerStateMutators` interface — the
 * narrow surface the master class exposes to let these functions
 * update its private state without becoming class methods themselves.
 */
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import type { RunCoderHandle } from '@mcp/code-agent/index/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type {
  IBoardPoster,
  IMetaBusWirer,
} from '@mcp/company/services/ports.js';
import { isTransientError } from '@mcp/company/RetryPolicy.js';

export interface MasterRunnerStateMutators {
  /** Existing attention-listener unsubscribe (null on first wire). */
  readonly attentionOff: (() => void) | null;
  /** Replace the attention-listener unsubscribe slot. */
  setAttentionOff: (off: (() => void) | null) => void;
  /** Set `_runnerExited` — must happen BEFORE _ended in the completion microtask. */
  setRunnerExited: (value: boolean) => void;
  /** Set `_ended` — happens in `.finally` so notifications route correctly. */
  setEnded: (value: boolean) => void;
  /**
   * Stamp the ISO timestamp of when the runner exited. Set alongside
   * `setEnded(true)` so the dashboard can render a "Master finished at
   * HH:MM" banner from the `session_idle` event. Null clears on
   * resurrection.
   */
  setEndedAt: (value: string | null) => void;
  /** Record an end-with-error string. Null clears. */
  setEndedWithError: (value: string | null) => void;
  /** Read `_ended` / `_runnerExited` flags. Needed by the attention listener. */
  readonly isEnded: boolean;
  readonly isRunnerExited: boolean;
  /** Emit `master.ended` to the internal event bus / idle controller. */
  notifyIdleEnded: () => void;
}

export interface WireMasterRunnerDeps {
  wirer: IMetaBusWirer;
  humanInLoop: HumanInTheLoop;
  attention: MasterAttention;
  state: MasterRunnerStateMutators;
}

/**
 * Plug HumanInTheLoop + meta-bus listeners onto the runner. Idempotent
 * over the attention listener: a previous registration is torn down
 * first so re-wiring on resurrect doesn't pile up handlers.
 */
export function wireMasterRunnerListeners(
  runner: CoderRunner,
  runId: string,
  deps: WireMasterRunnerDeps,
): void {
  const synthetic = { runner } as unknown as RunCoderHandle;
  deps.wirer.wire(synthetic, 'master', runId);
  deps.humanInLoop.wireMasterPlan(synthetic);
  deps.humanInLoop.wireMasterQuestion(synthetic);

  // Tear down any prior listener so resurrect doesn't accumulate them.
  if (deps.state.attentionOff) {
    try { deps.state.attentionOff(); } catch { /* best-effort */ }
  }

  // Permanent attention listener: every subordinate transition
  // (question/plan/tasks/finished) interrupts a pending waitForUserInput
  // on the master so the message enqueued by `master.notify` actually
  // gets consumed in the next turn. Cleaned up in the completion
  // handler's `.finally` callback.
  const off = deps.attention.on((ev) => {
    // `inbox_answered` is handled by the InboxQueue; `user_message` and
    // `notify` are consumed by the `wait_for_subordinates` loop returning and
    // draining pendingUserMessages on the next turn — not by interrupting a
    // waitForUserInput here. None is a subordinate event this listener acts on.
    if (ev.kind === 'inbox_answered' || ev.kind === 'user_message' || ev.kind === 'notify') return;
    if (deps.state.isEnded || deps.state.isRunnerExited) return;
    if (runner.isWaitingForInput()) {
      runner.interruptWait({
        kind: ev.kind === 'finished' ? 'subordinate_event' : ev.kind,
        agentRunId: ev.agentRunId,
        role: ev.role,
      });
    }
  });
  deps.state.setAttentionOff(off);
}

export interface AttachMasterCompletionDeps {
  ctx: SessionContext;
  board: Pick<IBoardPoster, 'post'>;
  humanInLoop: Pick<HumanInTheLoop, 'cancelPendingMasterPrompts'>;
  state: MasterRunnerStateMutators;
  /**
   * Company-owned App fallback hook. It must update runtime provenance before
   * starting the replacement runner and returns true only when continuation
   * was successfully attached.
   */
  tryExplicitFallback?: (errorDetail: string) => Promise<boolean>;
}

/**
 * Wrap `handle.done` with status + board + idle-notify cleanup. Every exit
 * sets `_runnerExited` before other work so a subordinate notification cannot
 * be pushed into a dead buffer. A transient App failure may hand ownership to
 * an explicitly configured fallback runner; only terminal exits set `_ended`,
 * tear down attention, cancel prompts and fire `notifyIdleEnded()`.
 */
export function attachMasterCompletionHandler(
  handle: RunCoderHandle,
  runId: string,
  deps: AttachMasterCompletionDeps,
): void {
  const finalizeTerminalExit = async (): Promise<void> => {
    deps.state.setEnded(true);
    // Timestamp the exit so the dashboard's session_idle handler can
    // surface "Master finished at HH:MM" or "Master ended unexpectedly"
    // without depending on the SSE delivery time (which can lag by
    // seconds during reconnects).
    deps.state.setEndedAt(new Date().toISOString());
    if (deps.state.attentionOff) {
      try { deps.state.attentionOff(); } catch { /* best-effort */ }
      deps.state.setAttentionOff(null);
    }
    await deps.humanInLoop.cancelPendingMasterPrompts().catch(() => undefined);
    deps.state.notifyIdleEnded();
  };

  const tryFallback = async (detail: string): Promise<boolean> => {
    if (!deps.tryExplicitFallback || !isTransientError(detail)) return false;
    try {
      return await deps.tryExplicitFallback(detail);
    } catch (error) {
      console.warn(
        `[company s=${deps.ctx.companySessionId}] explicit Master fallback failed:`,
        error,
      );
      return false;
    }
  };

  // Use one async owner instead of an unconditional `.finally`: a successful
  // fallback attaches a replacement runner to the same agent_run and must not
  // be overwritten to `ended/error` by the runner it replaced.
  void (async () => {
    let continuedWithFallback = false;
    try {
      const { reason, error } = await handle.done;
      deps.state.setRunnerExited(true);
      const detail = error ? ` — ${error}` : '';
      if (reason !== 'completed') {
        continuedWithFallback = await tryFallback(error ?? `${reason}${detail}`);
        if (continuedWithFallback) return;
      }
      await deps.ctx.companyFiles.updateAgentRunStatus(
        runId,
        reason === 'completed' ? 'completed' : 'error',
        reason !== 'completed' ? `${reason}${detail}` : undefined,
      ).catch(() => undefined);
      if (reason !== 'completed') {
        deps.state.setEndedWithError(`${reason}${detail}`);
      }
      try {
        deps.board.post('system', null, 'message', `Master finished: ${reason}${detail}`);
      } catch { /* best-effort */ }
    } catch (err) {
      deps.state.setRunnerExited(true);
      const errMessage = err instanceof Error ? err.message : String(err);
      continuedWithFallback = await tryFallback(errMessage);
      if (continuedWithFallback) return;
      await deps.ctx.companyFiles
        .updateAgentRunStatus(runId, 'error')
        .catch(() => undefined);
      deps.state.setEndedWithError(errMessage);
      try {
        deps.board.post('system', null, 'message', `Master error: ${errMessage}`);
      } catch { /* best-effort */ }
    } finally {
      if (!continuedWithFallback) await finalizeTerminalExit();
    }
  })();
}
