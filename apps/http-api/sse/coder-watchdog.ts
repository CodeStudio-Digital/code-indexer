/**
 * Frente E — periodic server-side watchdog.
 *
 * The orchestrator's `finally` block already runs `recoverStaleTasks`
 * when the BT exits cleanly. That handles the common case. But the
 * pathological case is a worker process that hangs WITHOUT throwing
 * (provider response that never resolves, MCP tool that escapes the
 * dispatch timeout via custom Promise behaviour, …). In those scenarios
 * the BT never reaches its `finally`, the session row stays in
 * `running` indefinitely, and the dashboard shows a phantom spinner.
 *
 * The watchdog wakes up every `intervalMs` (default 5 minutes) and
 * scans filesystem session projections whose `updated_at` is older than
 * `staleAfterMs` (default 10 minutes). Anything that old is forced back to
 * `idle`, freeing the dashboard.
 *
 * Conservative thresholds — a long compaction or a slow provider
 * shouldn't trip the watchdog. The boot-time `recoverStaleSessions()`
 * sweep (server.ts line ~420) covers the broader case of restart
 * victims; the periodic sweep only catches in-flight hangs.
 *
 * The companion task-orphan recovery is already covered by
 * `recoverStaleTasks` and `recoverRunningTaskRuns` in the orchestrator's
 * cleanup. Running them here as well would double-trip but is harmless;
 * the trade-off favours catching stragglers (e.g. a session in
 * `running` whose orchestrator never even started because the worker
 * crashed mid-`runCoder()` invocation).
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

interface CoderWatchdogHandle {
  /** Stop the periodic sweep. Idempotent. */
  stop(): void;
  /** Force a one-shot sweep RIGHT NOW (returns the number of rows touched). */
  runOnce(): Promise<number>;
  /** Inspect current configuration for logging / tests. */
  readonly intervalMs: number;
  readonly staleAfterMs: number;
}

interface StartCoderWatchdogArgs {
  sessionStore: {
    recoverStuckRunningSessions(options: {
      maxAgeMs?: number;
    }): Promise<number>;
  };
  /** Override for tests / tighter monitoring. Defaults to 5 minutes. */
  intervalMs?: number;
  /** Override for tests. Defaults to 10 minutes. */
  staleAfterMs?: number;
  /** Hook for telemetry — fired after every sweep, healthy or not. */
  onSweep?: (info: { recovered: number; durationMs: number }) => void;
}

/**
 * Spawn the periodic watchdog. Returns a handle so the host can stop
 * it on graceful shutdown. The handle is safe to ignore in development
 * (the timer is `unref()`-ed so it never blocks process exit on its own).
 */
export function startCoderWatchdog(args: StartCoderWatchdogArgs): CoderWatchdogHandle {
  const intervalMs = args.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleAfterMs = args.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  let stopped = false;

  const sweepOnce = async (): Promise<number> => {
    if (stopped) return 0;
    const startedAt = Date.now();
    let recovered = 0;
    try {
      recovered = await args.sessionStore.recoverStuckRunningSessions({
        maxAgeMs: staleAfterMs,
      });
    } catch (e) {
      console.warn(
        `[coder/watchdog] recoverStuckRunningSessions failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 0;
    }
    const durationMs = Date.now() - startedAt;
    if (recovered > 0) {
      console.log(
        `[coder/watchdog] swept — recovered=${recovered} stuck session(s) ` +
        `(stale>${Math.round(staleAfterMs / 1000)}s, durationMs=${durationMs})`,
      );
    }
    try {
      args.onSweep?.({ recovered, durationMs });
    } catch (e) {
      console.warn(
        `[coder/watchdog] onSweep hook failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return recovered;
  };

  const timer = setInterval(() => {
    void sweepOnce();
  }, intervalMs);
  // Don't keep the Node process alive solely for the watchdog — if every
  // other handle drains (request close, DB close), let the runtime exit.
  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `[coder/watchdog] started — interval=${Math.round(intervalMs / 1000)}s ` +
    `staleAfter=${Math.round(staleAfterMs / 1000)}s`,
  );

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      console.log('[coder/watchdog] stopped');
    },
    runOnce(): Promise<number> {
      return sweepOnce();
    },
    intervalMs,
    staleAfterMs,
  };
}
