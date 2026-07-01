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
/** Busy-but-stuck threshold: no SEMANTIC progress despite running agents. */
const DEFAULT_SEMANTIC_STALL_MS = 10 * 60 * 1000;

/**
 * Events that represent real progress (a work product / state transition), as
 * opposed to heartbeats (text_delta, tool_progress) or churn (agent_status).
 * When subordinates are running but NONE of these fire for a while, the org is
 * "busy but stuck" — the most common real stall, invisible to the plain idle
 * check (which resets on ANY bus event and skips while agents run).
 */
function isSemanticProgress(event: string): boolean {
  return (
    event === 'board_entry' ||
    event.startsWith('kanban_card_') ||
    event === 'inbox_message_delivered'
  );
}

export interface IdleWatchdogDeps {
  ctx: SessionContext;
  bus: IMetaBusPublisher;
  master: Pick<IMasterNotifier, never> & { readonly hasEnded: boolean };
  subordinates: ISubordinateQuery;
  /** Override for tests. Defaults to `Date.now()`. */
  now?: () => number;
}

export class IdleWatchdog {
  private readonly thresholdMs: number;
  private readonly semanticThresholdMs: number;
  private readonly tickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = 0;
  private lastSemanticActivityAt = 0;
  private notifiedForStallStartedAt: number | null = null;
  private notifiedForSemanticStallAt: number | null = null;

  constructor(private readonly deps: IdleWatchdogDeps) {
    const threshold = Number(process.env.MCP_AGENT_WATCHDOG_MS);
    const semantic = Number(process.env.MCP_AGENT_SEMANTIC_STALL_MS);
    const tick = Number(process.env.MCP_AGENT_WATCHDOG_TICK_MS);
    this.thresholdMs = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_STALL_THRESHOLD_MS;
    this.semanticThresholdMs = Number.isFinite(semantic) && semantic > 0 ? semantic : DEFAULT_SEMANTIC_STALL_MS;
    this.tickMs = Number.isFinite(tick) && tick > 0 ? tick : DEFAULT_TICK_INTERVAL_MS;
    this.lastActivityAt = this.nowMs();
    this.lastSemanticActivityAt = this.nowMs();
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Don't keep the Node event loop alive just for the watchdog —
    // if the process is otherwise idle, the watchdog can sleep.
    const timer = this.timer as { unref?: () => void } | null;
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** Called by `MetaBusPublisher.publish` on every event. `event` lets us
   *  separate real progress from heartbeats/churn for the busy-stuck check. */
  recordActivity(event?: string): void {
    const now = this.nowMs();
    this.lastActivityAt = now;
    this.notifiedForStallStartedAt = null;
    if (event && isSemanticProgress(event)) {
      this.lastSemanticActivityAt = now;
      this.notifiedForSemanticStallAt = null;
    }
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

    // Busy-but-stuck: subordinates ARE running but produced no real progress
    // (no board post / kanban transition / delivery) for a long window. The
    // plain idle check below can't see this — it skips while agents run and
    // resets on any heartbeat. We only signal (banner), never auto-kill.
    if (this.deps.subordinates.runningCount > 0) {
      const noProgressMs = this.nowMs() - this.lastSemanticActivityAt;
      if (
        noProgressMs >= this.semanticThresholdMs &&
        this.notifiedForSemanticStallAt !== this.lastSemanticActivityAt
      ) {
        this.deps.bus.publish('session_stalled', {
          stalledSinceMs: noProgressMs,
          reason: 'busy_no_progress' as const,
        });
        this.notifiedForSemanticStallAt = this.lastSemanticActivityAt;
      }
      return;
    }

    const stalledSinceMs = this.nowMs() - this.lastActivityAt;
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
