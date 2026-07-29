/**
 * ApprovalBatcher (C4) — debounces master notifications for pending
 * subordinate PLANS so a burst of submissions becomes ONE aggregated
 * summary instead of N separate `[SYSTEM]` messages (each of which costs
 * the master a full LLM turn of attention).
 *
 * Division of labor with HumanInTheLoop:
 *   - The FIRST pending plan is still notified immediately and verbatim
 *     (that path is untouched — single plan = normal notify, zero latency).
 *   - From the SECOND simultaneous pending plan on, HitL calls `signal()`
 *     instead of notifying; the batcher arms ONE fixed window (default 5s)
 *     and then invokes `flush`, which reads the live pending-plans map and
 *     sends a single summary (`formatPendingPlansSummary`).
 *
 * With the default autonomy config (`autoApproveRoles: '*'`) plans never
 * reach the blocked path, so the batcher only ever acts when the session
 * has turned auto-approve off.
 *
 * Pure parts (summary formatting, plan-title extraction) are exported for
 * direct testing; the timing shell takes an injectable `schedule` so tests
 * drive it with a fake clock.
 */

const DEFAULT_WINDOW_MS = 5_000;

/** What the summary needs to know about one pending plan. */
export interface PendingPlanSummaryEntry {
  agentRunId: string;
  role: string;
  planText: string;
}

/** First non-empty line of the plan, trimmed to `max` chars. Pure. */
export function planTitle(planText: string, max = 80): string {
  const line = planText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '(empty plan)';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One aggregated `[SYSTEM]` message for N pending plans. Pure. */
export function formatPendingPlansSummary(
  entries: ReadonlyArray<PendingPlanSummaryEntry>,
): string {
  const lines = entries.map(
    (e) => `  - @${e.role} (agent_run_id=${e.agentRunId}): "${planTitle(e.planText)}"`,
  );
  return (
    `[SYSTEM] ${entries.length} subordinate plans are awaiting your approval — ` +
    `each agent is BLOCKED until you respond:\n${lines.join('\n')}\n` +
    `Respond to ALL in one call with approve_subordinate_plans(` +
    `approvals=[{agent_run_id, approved, feedback?}, ...]) — or individually ` +
    `with approve_subordinate_plan. Check the board for each plan's full text.`
  );
}

/** setTimeout-compatible scheduler: returns a cancel function. */
export type BatcherSchedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: BatcherSchedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  // Never hold the process alive for a pending summary.
  if (typeof (t as { unref?: () => void }).unref === 'function') {
    (t as unknown as { unref: () => void }).unref();
  }
  return () => clearTimeout(t);
};

export interface ApprovalBatcherOpts {
  /** Called once when the window elapses. Reads live state — not payloads. */
  flush: () => void;
  /** Aggregation window. Default 5000ms. */
  windowMs?: number;
  /** Injectable timer for tests (fake clock). Default: setTimeout (unref'd). */
  schedule?: BatcherSchedule;
}

export class ApprovalBatcher {
  private cancelTimer: (() => void) | null = null;

  constructor(private readonly opts: ApprovalBatcherOpts) {}

  /** True while a window is armed and waiting to flush. */
  get armed(): boolean {
    return this.cancelTimer !== null;
  }

  /**
   * Arm the aggregation window (idempotent — further signals inside the
   * window coalesce into the already-scheduled flush). The window is FIXED
   * from the first signal, not sliding, so a steady trickle of plans can't
   * postpone the summary forever.
   */
  signal(): void {
    if (this.cancelTimer) return;
    const schedule = this.opts.schedule ?? defaultSchedule;
    this.cancelTimer = schedule(() => {
      this.cancelTimer = null;
      try {
        this.opts.flush();
      } catch {
        /* a flush failure must never take the timer chain down */
      }
    }, this.opts.windowMs ?? DEFAULT_WINDOW_MS);
  }

  /** Drop any armed window without flushing (session abort/finalize). */
  cancel(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }
}
