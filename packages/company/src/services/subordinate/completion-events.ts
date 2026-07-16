/**
 * Subordinate completion event bus (C5 — Sprint 2).
 *
 * Loose pub/sub for "a subordinate just finished". Existing per-port
 * notifiers (`IKanbanNotifier`, `IMasterNotifier`) keep their roles —
 * this bus is **additive** for code that wants to react to completions
 * WITHOUT blocking the response path:
 *
 *   - telemetry sinks (e.g. record per-role outcome to pipeline_telemetry)
 *   - kanban_sync (move card state, post comments) when not already
 *     handled by IKanbanNotifier
 *   - role history collectors for the next RolePipeline run
 *   - cost-accounting batchers
 *
 * **Why a bus and not more ports**: ports require an extra interface,
 * an implementation class, and constructor wiring per consumer. The
 * bus pattern lets new
 * listeners attach without changing the orchestrator's deps shape.
 * Direct port from `home-mixer/side_effects/*` in xai-org/x-algorithm.
 *
 * **Fire-and-forget contract**: `emit()` schedules listeners via
 * `setImmediate` so the completion handler returns to the caller
 * immediately. Listener errors are caught and logged — they cannot
 * break the response or other listeners.
 */

export interface SubordinateCompletionEvent {
  agentRunId: number;
  role: string;
  /** 'completed' for clean done; 'failed' for any non-completed reason. */
  outcome: 'completed' | 'failed';
  /** Failure reason class — only set when outcome='failed'. */
  failureReason?: string;
  /** Final assistant text (truncated to ~2k chars) — for telemetry/audit. */
  finalText?: string;
  /** Tokens consumed by this run — for cost accounting. */
  tokensUsed?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
    thinking?: number;
  };
  /** Wall-clock duration in ms from spawn → completion. */
  durationMs?: number;
  /** Kanban card id when the subordinate owned one. */
  kanbanCardId?: number | null;
  /** Wall-clock ms when the event fired. */
  emittedAtMs: number;
}

/**
 * A listener may be sync or async. Async listeners are awaited by the
 * bus so they finish before the next event in the same `setImmediate`
 * tick, but the original `emit()` caller does NOT wait.
 */
export type SubordinateCompletionListener = (
  event: SubordinateCompletionEvent,
) => void | Promise<void>;

/**
 * Process-wide bus. Singleton instance lives in
 * `subordinateCompletionBus` (exported below) — same pattern as
 * the global tool-selection filter. Tests get a fresh instance via
 * `new SubordinateCompletionBus()`.
 */
export class SubordinateCompletionBus {
  private listeners: SubordinateCompletionListener[] = [];

  /**
   * Register a listener. Returns an unsubscribe function. Listeners
   * fire in registration order on each event.
   */
  on(listener: SubordinateCompletionListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Drop all listeners — test helper. Production code should track its
   * own unsubscribe callbacks instead.
   */
  clear(): void {
    this.listeners = [];
  }

  /** Count for diagnostics / tests. */
  size(): number {
    return this.listeners.length;
  }

  /**
   * Fire-and-forget emit: caller returns immediately, listeners run on
   * the next event-loop tick. One listener's error is logged and does
   * not affect subsequent listeners or the emit caller.
   */
  emit(event: SubordinateCompletionEvent): void {
    const snapshot = [...this.listeners]; // freeze list against concurrent on/off
    setImmediate(async () => {
      for (const listener of snapshot) {
        try {
          await listener(event);
        } catch (e) {
          console.warn(
            `[company] subordinate completion listener threw: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    });
  }

  /**
   * Synchronous variant — used by tests that need deterministic
   * before/after assertions without `await new Promise(setImmediate)`.
   * Production code should ALWAYS use `emit()` so listeners run off
   * the response path.
   */
  async emitSync(event: SubordinateCompletionEvent): Promise<void> {
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        await listener(event);
      } catch (e) {
        console.warn(
          `[company] subordinate completion listener threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
}

/**
 * Default singleton — `apps/http-api/server/deps.ts` registers cross-
 * cutting listeners (telemetry, role-history) against this. Per-session
 * orchestrators consult it when emitting.
 */
export const subordinateCompletionBus = new SubordinateCompletionBus();
