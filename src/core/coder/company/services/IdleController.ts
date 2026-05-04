/**
 * IdleController — manages the transition from "active session" to
 * "paused / waiting for user input" when both the master and all
 * subordinates are done.
 *
 * Behavior:
 *   - Publishes `session_idle` to the meta-bus instead of closing it —
 *     the SSE stream stays alive so the user can send follow-up messages
 *     that resurrect the master.
 *   - Enriches `session_idle` with `master_error` + errorDetail when the
 *     master ended with an error, so the dashboard can show an
 *     actionable banner ("Master failed — send a message to retry").
 *   - After `idleTimeoutMs` of inactivity, closes the bus with
 *     `done(idle_timeout)`.
 *   - Auto-continue hook: when the user just answered a master plan/question,
 *     the master is automatically resumed with a "continue" message.
 *
 * Configurable via CODER_COMPANY_IDLE_TIMEOUT_MS (default 10 min).
 */

import type { SessionContext } from './SessionContext.js';
import type {
  IIdleController,
  IMasterNotifier,
  IMetaBusPublisher,
  ISubordinateQuery,
} from './ports.js';

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export interface IdleControllerDeps {
  ctx: SessionContext;
  bus: IMetaBusPublisher;
  subordinates: ISubordinateQuery;
  /** Called when auto-continue should resurrect the master with a default prompt. */
  onAutoContinue: () => void;
  consumeMasterShouldContinue: () => boolean;
  master: Pick<IMasterNotifier, 'endedWithError'> & { readonly hasEnded: boolean };
}

export class IdleController implements IIdleController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly deps: IdleControllerDeps) {
    const env = Number(process.env.CODER_COMPANY_IDLE_TIMEOUT_MS);
    this.timeoutMs = Number.isFinite(env) && env > 0 ? env : DEFAULT_IDLE_TIMEOUT_MS;
  }

  onMasterEnded(): void {
    this.checkIdle();
  }

  onSubordinatesChanged(): void {
    this.checkIdle();
  }

  onMasterResurrected(): void {
    this.clear();
  }

  onUserMessageReceived(): void {
    this.clear();
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Evaluate whether the session should transition to idle/paused.
   * Safe to call multiple times — it's a no-op when conditions aren't met.
   */
  private checkIdle(): void {
    if (this.deps.ctx.isAborted || this.deps.ctx.isBusEnded) return;
    if (!this.deps.master.hasEnded) return;
    if (this.deps.subordinates.runningCount > 0) return;

    // Auto-continue after question/plan answer — the master acknowledged
    // the answer but didn't make tool calls, so the runner exited. Resume
    // it so it can proceed with the next orchestration step.
    if (this.deps.consumeMasterShouldContinue()) {
      this.deps.onAutoContinue();
      return;
    }

    // Transition this session to "paused" — bus stays alive for follow-up
    // messages. With migration 067, sub-sessions are full CompanySession
    // rows so this single status field is naturally per-tab.
    try {
      this.deps.ctx.companyStore.updateCompanySessionStatus(
        this.deps.ctx.companySessionId,
        'paused',
      );
    } catch { /* ignore */ }

    const err = this.deps.master.endedWithError;
    const idlePayload = err
      ? { reason: 'master_error' as const, errorDetail: err }
      : { reason: 'waiting_for_input' as const };
    this.deps.bus.publish('session_idle', idlePayload);
    this.resetTimer();
  }

  private resetTimer(): void {
    this.clear();
    this.timer = setTimeout(() => {
      if (
        this.deps.master.hasEnded &&
        this.deps.subordinates.runningCount === 0 &&
        !this.deps.ctx.isAborted &&
        !this.deps.ctx.isBusEnded
      ) {
        try {
          this.deps.ctx.companyStore.updateCompanySessionStatus(
            this.deps.ctx.companySessionId,
            'completed',
          );
        } catch { /* ignore */ }
        this.deps.bus.markEnded('done', { reason: 'idle_timeout' });
      }
    }, this.timeoutMs);
  }
}
