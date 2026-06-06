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
import type { RunCoderHandle } from '@mcp/code-agent/index.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type {
  IBoardPoster,
  IMetaBusWirer,
} from '@mcp/company/services/ports.js';

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
  runId: number,
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
    // `inbox_answered` is handled by the InboxQueue; `user_message` by the
    // `wait_for_subordinates` loop (and sendUserMessage's interject path).
    // Neither is a subordinate event this master listener should act on.
    if (ev.kind === 'inbox_answered' || ev.kind === 'user_message') return;
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
}

/**
 * Wrap `handle.done` with the status + board + idle-notify cleanup.
 * Three exit paths (each set `_runnerExited` BEFORE other work so a
 * subordinate notify() arriving in the same microtask routes to
 * `resurrect` instead of pushing into a dead buffer):
 *
 *   - `.then` — status `completed` or `error`, board "Master finished" post.
 *   - `.catch` — status `error`, board "Master error" post.
 *   - `.finally` — set `_ended`, tear down attention listener, cancel
 *     pending master prompts, fire `notifyIdleEnded()`.
 */
export function attachMasterCompletionHandler(
  handle: RunCoderHandle,
  runId: number,
  deps: AttachMasterCompletionDeps,
): void {
  handle.done
    .then(({ reason, error }) => {
      deps.state.setRunnerExited(true);
      const detail = error ? ` — ${error}` : '';
      try {
        deps.ctx.companyStore.updateAgentRunStatus(
          runId,
          reason === 'completed' ? 'completed' : 'error',
          reason !== 'completed' ? `${reason}${detail}` : undefined,
        );
      } catch { /* ignore */ }
      if (reason !== 'completed') {
        deps.state.setEndedWithError(`${reason}${detail}`);
      }
      deps.board.post('system', null, 'message', `Master finished: ${reason}${detail}`);
    })
    .catch((err: unknown) => {
      deps.state.setRunnerExited(true);
      try {
        deps.ctx.companyStore.updateAgentRunStatus(runId, 'error');
      } catch { /* ignore */ }
      const errMessage = err instanceof Error ? err.message : String(err);
      deps.state.setEndedWithError(errMessage);
      deps.board.post('system', null, 'message', `Master error: ${errMessage}`);
    })
    .finally(() => {
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
      try {
        deps.humanInLoop.cancelPendingMasterPrompts();
      } catch { /* best-effort */ }
      deps.state.notifyIdleEnded();
    });
}
