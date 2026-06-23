/**
 * IdleWatchdog — periodic check that detects "stuck" sessions and
 * publishes a `session_stalled` event so the dashboard can surface a
 * banner with a manual nudge button. Zero LLM cost: the watchdog
 * never calls the model itself, it only reads in-memory state and
 * publishes a small event.
 *
 * A session is "stalled" when ALL of the following hold:
 *   - Master is still alive (`!master.hasEnded`)
 *   - No subordinates are running (`subordinates.runningCount === 0`)
 *   - More than `stallThresholdMs` have passed since the last activity
 *
 * "Activity" = any publish on the meta-bus. Wired via the publisher's
 * `onPublish` hook in `MetaBusPublisher`.
 *
 * The watchdog fires ONCE per stall window. Any activity that arrives
 * after the stall notice resets the timestamp so a fresh stall later
 * notifies again.
 *
 * Configurable via `MCP_AGENT_WATCHDOG_MS` (default 5 min) for the
 * threshold, and `MCP_AGENT_WATCHDOG_TICK_MS` (default 60 s) for the
 * polling cadence.
 */
import type { SessionContext } from './SessionContext.js';
import type { IMasterNotifier, IMetaBusPublisher, ISubordinateQuery } from './ports.js';

const DEFAULT_STALL_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_TICK_INTERVAL_MS = 60 * 1000;

export interface IdleWatchdogDeps {
  ctx: SessionContext;
  bus: IMetaBusPublisher;
  master: Pick<IMasterNotifier, never> & { readonly hasEnded: boolean };
  subordinates: ISubordinateQuery;
}

export class IdleWatchdog {
  private readonly thresholdMs: number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt: number = Date.now();
  private notifiedForStallStartedAt: number | null = null;

  constructor(private readonly deps: IdleWatchdogDeps) {
    const threshold = Number(process.env.MCP_AGENT_WATCHDOG_MS);
    const tick = Number(process.env.MCP_AGENT_WATCHDOG_TICK_MS);
    this.thresholdMs = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_STALL_THRESHOLD_MS;
    this.tickMs = Number.isFinite(tick) && tick > 0 ? tick : DEFAULT_TICK_INTERVAL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Don't keep the Node event loop alive just for the watchdog —
    // if the process is otherwise idle, the watchdog can sleep.
    const timer = this.timer as { unref?: () => void } | null;
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** Called by `MetaBusPublisher.publish` on every event. */
  recordActivity(): void {
    this.lastActivityAt = Date.now();
    this.notifiedForStallStartedAt = null;
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (this.deps.ctx.isAborted || this.deps.ctx.isBusEnded) return;
    if (this.deps.master.hasEnded) return;
    if (this.deps.subordinates.runningCount > 0) return;

    const stalledSinceMs = Date.now() - this.lastActivityAt;
    if (stalledSinceMs < this.thresholdMs) return;

    // Already notified for THIS stall window? Skip — the dashboard
    // has the banner; re-publishing would just flicker it.
    if (
      this.notifiedForStallStartedAt !== null &&
      this.lastActivityAt <= this.notifiedForStallStartedAt
    ) {
      return;
    }

    this.deps.bus.publish('session_stalled', {
      stalledSinceMs,
      reason: 'no_progress' as const,
    });
    this.notifiedForStallStartedAt = this.lastActivityAt;
  }
}
