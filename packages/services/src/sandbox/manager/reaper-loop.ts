/**
 * TTL reaper loop. Every 60s scans the in-memory primary sandboxes for:
 *
 *   1. Soft TTL: `ready` sandboxes idle longer than `pauseTtlMs` →
 *      transition to `paused` (file system preserved, container stopped).
 *      Opt-in via `MCP_SANDBOX_AUTO_IDLE_REAPER=1` — manual-first lifecycle
 *      keeps this off by default so user-driven pause/resume rules.
 *   2. Hard TTL: `paused` sandboxes that have been paused longer than
 *      `destroyAfterPauseMs` → full destroy. Same opt-in flag.
 *   3. Always-on: stale `error` sandboxes get cleaned out after
 *      `destroyAfterPauseMs` regardless of the flag — they're no longer
 *      actionable and clutter the dashboard.
 *
 * Extracted from `SandboxManager.startReaper` so the policy can be
 * exercised with `vi.useFakeTimers()` + a fake driver without taking on
 * the rest of the manager's surface.
 */
import type { Sandbox } from '@mcp/services/sandbox/types.js';
import type { CompanySandboxStore } from '@mcp/store/company-sandbox-store.js';
import { IntervalTimer } from '@mcp/services/sandbox/manager/reaper/interval-timer.js';

export interface ReaperLoopDeps {
  listSandboxes: () => Iterable<Sandbox>;
  getStore: () => CompanySandboxStore | null;
  resolveDriverOnce: () => Promise<unknown>;
  pauseSandbox: (sessionId: string, reason: string) => Promise<void>;
  destroyInternal: (sessionId: string, reason: string) => Promise<void>;
  isShuttingDown: () => boolean;
  /** Soft TTL — running → paused. */
  pauseTtlMs: number;
  /** Hard TTL — paused → destroyed. */
  destroyAfterPauseMs: number;
  /** Default 60_000ms; tests pass a smaller value via override. */
  tickIntervalMs?: number;
}

/**
 * Run one tick of the reaper logic. Exported for tests; production
 * callers go through `startReaperLoop`.
 */
export async function reaperTick(deps: ReaperLoopDeps): Promise<void> {
  if (deps.isShuttingDown()) return;
  const now = Date.now();

  if (process.env.MCP_SANDBOX_AUTO_IDLE_REAPER === '1') {
    try {
      await deps.resolveDriverOnce();
    } catch {
      return; // can't reap without a driver; try next tick
    }

    // ─── Soft tier: running → paused ───
    for (const sb of deps.listSandboxes()) {
      if (sb.status !== 'ready' || sb.runtimePaused) continue;
      const idleMs = now - sb.lastAccessAt;
      if (idleMs >= deps.pauseTtlMs) {
        console.log(
          `[sandbox-manager] pausing session=${sb.id} (idle for ${Math.round(idleMs / 1000)}s >= ${Math.round(deps.pauseTtlMs / 1000)}s soft TTL)`,
        );
        void deps.pauseSandbox(sb.id, 'idle-soft-ttl');
      }
    }

    // ─── Hard tier: paused → destroyed ───
    const store = deps.getStore();
    if (store) {
      const stale = store.listPausedOlderThan(deps.destroyAfterPauseMs);
      for (const row of stale) {
        console.log(
          `[sandbox-manager] destroying paused session=${row.session_id} (paused for > ${Math.round(deps.destroyAfterPauseMs / 1000)}s hard TTL)`,
        );
        void deps.destroyInternal(String(row.session_id), 'idle-hard-ttl');
      }
    } else {
      for (const sb of deps.listSandboxes()) {
        if (sb.status !== 'paused') continue;
        const pausedFor = now - sb.lastAccessAt;
        if (pausedFor >= deps.destroyAfterPauseMs) {
          void deps.destroyInternal(sb.id, 'idle-hard-ttl');
        }
      }
    }
  }

  // Always-on: surface errored sandboxes for cleanup after a long wait.
  // Errors stay visible in the UI so the user can click Retry; after a
  // day they're no longer actionable — clear them out.
  for (const sb of deps.listSandboxes()) {
    if (sb.status !== 'error') continue;
    const idleMs = now - sb.lastAccessAt;
    if (idleMs >= deps.destroyAfterPauseMs) {
      void deps.destroyInternal(sb.id, 'stale-error');
    }
  }
}

/** Start the periodic reaper. Returns the timer for shutdown teardown. */
export function startReaperLoop(deps: ReaperLoopDeps): IntervalTimer {
  const interval = deps.tickIntervalMs ?? 60_000;
  const timer = new IntervalTimer(interval, () => reaperTick(deps));
  timer.start();
  return timer;
}
