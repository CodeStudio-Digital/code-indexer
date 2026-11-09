/**
 * runAgentWaitLoop — the single event-driven wait mechanism shared by the
 * two "wait for agents" tools, which previously duplicated this loop
 * byte-for-byte (and therefore the same deadlock):
 *
 *   - `wait_for_subordinates` (master-only) — waits for the WHOLE running
 *     fleet. Pass `targetIds: null`.
 *   - `wait_agents` (cross-tier) — waits for a FIXED set of target agents.
 *     Pass `targetIds: Set<agentRunId>`.
 *
 * The tools stay thin wrappers: they build the orchestrator + options, call
 * this loop, and format the structured {@link AgentWaitOutcome} with their
 * own copy text. All the tricky concurrency (listener (re)subscription,
 * safety polling, master-vs-subordinate gating) lives here, once.
 *
 * Deadlock fix (the reason this was extracted): the loop sleeps on an
 * `attention` signal, but the listener is torn down + re-subscribed every
 * iteration. If the LAST agent's `finished` signal fires in that gap it is
 * lost, `runningCount` is already 0, and the master would sleep until the
 * 30-min deadline. The `setTimeout` is capped at {@link SAFETY_POLL_MS} so
 * the loop re-checks the done-condition within ~2s regardless — without
 * running the LLM. Event-driven wake still fires instantly via the listener.
 */
import type {
  AttentionEvent,
  AttentionListener,
} from '@mcp/company/services/MasterAttention.js';
import { getGlobalAgentSupervisor } from '@mcp/company/services/supervisor/global.js';

/** Statuses that mean a target agent has reached a terminal state. */
const TERMINAL_STATUSES = new Set<string>([
  'completed', 'finished', 'failed', 'aborted', 'timed_out', 'error',
]);

/**
 * Hard cap on a single sleep inside the wait loop. Bounds how long the loop
 * can stay parked before it re-evaluates the done-condition even if the
 * wake signal was lost. 2s is invisible to a human and trivial cost (it only
 * re-reads a counter / status list — never an LLM turn).
 */
export const SAFETY_POLL_MS = 2000;

/** Structured result — the wrapper tool turns this into its own copy text. */
export type AgentWaitOutcome =
  | { kind: 'aborted' }
  | { kind: 'all_done' }
  /** Master only: a notification is buffered; return so the runner drains it. */
  | { kind: 'pending_messages' }
  /** Master only: a subordinate posted something the master must resolve. */
  | { kind: 'attention'; event: { kind: 'question' | 'plan' | 'tasks'; agentRunId: string; role: string } }
  /** Master only: a notify/user_message wake landed — read the queue. */
  | { kind: 'message'; via: 'notify' | 'user_message' }
  /** The caller's own internal wait window elapsed (soft for fleet, hard for targets). */
  | { kind: 'deadline' };

/** Narrow structural slice of the orchestrator the loop needs. */
export interface WaitLoopOrchestrator {
  hasRunningSubordinates(): boolean;
  listSubordinates(): ReadonlyArray<{ agentRunId: string; status: string }>;
  onSubordinateAttention(listener: AttentionListener): () => void;
  masterHasPendingMessages(): boolean;
}

export interface AgentWaitLoopOpts {
  signal?: AbortSignal;
  /** `null` = whole running fleet (dynamic). `Set` = these fixed targets. */
  targetIds: ReadonlySet<string> | null;
  /** Master gets the early-returns; subordinates only get `all_done`/`deadline`. */
  isMaster: boolean;
  /** Absolute wall-clock deadline (ms epoch). */
  deadlineMs: number;
  /** Poll cadence override (tests). Default {@link SAFETY_POLL_MS}. */
  pollMs?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
  /**
   * When set, the loop heartbeats this agent's supervisor record on every
   * poll. A `wait_for_subordinates` / `wait_agents` call parks the caller in a
   * single long `AWAITING_TOOL` (up to 30 min) that emits no `tool_progress`,
   * so without this the supervisor would flag a perfectly healthy waiter as
   * `STUCK_TOOL`. No-op when the supervisor is disabled or the agent isn't
   * tracked. This is what makes wiring the master into the supervisor safe.
   */
  heartbeatAgentRunId?: string;
}

export async function runAgentWaitLoop(
  orchestrator: WaitLoopOrchestrator,
  opts: AgentWaitLoopOpts,
): Promise<AgentWaitOutcome> {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? SAFETY_POLL_MS;
  const { targetIds, isMaster, deadlineMs } = opts;

  const isDone = (): boolean => {
    if (targetIds === null) return !orchestrator.hasRunningSubordinates();
    const subs = orchestrator.listSubordinates();
    for (const id of targetIds) {
      const sub = subs.find((s) => s.agentRunId === id);
      if (sub && !TERMINAL_STATUSES.has(sub.status)) return false; // still running
    }
    return true;
  };

  while (!isDone()) {
    if (opts.signal?.aborted) return { kind: 'aborted' };
    // Keep the supervisor from mistaking a healthy long wait for a stuck tool.
    if (opts.heartbeatAgentRunId != null) {
      getGlobalAgentSupervisor()?.heartbeat(opts.heartbeatAgentRunId);
    }
    // Level-trigger (master only): a notification was queued while we weren't
    // subscribed — return so the runner drains it on the next turn.
    if (isMaster && orchestrator.masterHasPendingMessages()) {
      return { kind: 'pending_messages' };
    }
    const remaining = deadlineMs - now();
    if (remaining <= 0) return { kind: 'deadline' };

    const event = await new Promise<AttentionEvent | { kind: 'timeout' } | { kind: 'aborted' }>((resolve) => {
      let settled = false;
      const off = orchestrator.onSubordinateAttention((ev) => {
        if (settled) return;
        // inbox_answered is subordinate↔subordinate — never wakes a waiter.
        if (ev.kind === 'inbox_answered') return;
        // notify/user_message are master-queue wakes; subordinates ignore them.
        if ((ev.kind === 'notify' || ev.kind === 'user_message') && !isMaster) return;
        // Targets mode: only react to lifecycle events ABOUT a target. The
        // master-queue wakes (notify/user_message) carry the master's own id,
        // so let them through.
        if (
          targetIds !== null &&
          ev.kind !== 'notify' &&
          ev.kind !== 'user_message' &&
          ev.agentRunId != null &&
          !targetIds.has(ev.agentRunId)
        ) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        off();
        opts.signal?.removeEventListener('abort', abort);
        resolve(ev);
      });
      // Safety poll (the deadlock fix): cap the sleep so we re-check isDone()
      // even if the wake signal was lost. Event-driven wake still fires above.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        opts.signal?.removeEventListener('abort', abort);
        resolve({ kind: 'timeout' });
      }, Math.min(remaining, pollMs));
      const abort = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); off(); opts.signal?.removeEventListener('abort', abort);
        resolve({ kind: 'aborted' });
      };
      opts.signal?.addEventListener('abort', abort, { once: true });
      if (opts.signal?.aborted) abort();
    });

    // 'timeout'/'finished' (and non-target lifecycle events for subordinates)
    // → loop and re-check isDone(). `inbox_answered` never reaches here (the
    // listener drops it) but narrows the union for the master branches below.
    if (event.kind === 'aborted') return { kind: 'aborted' };
    if (
      event.kind === 'timeout' ||
      event.kind === 'finished' ||
      event.kind === 'inbox_answered'
    ) continue;
    if (!isMaster) continue; // subordinates only resolve on terminal status
    if (event.kind === 'notify' || event.kind === 'user_message') {
      return { kind: 'message', via: event.kind };
    }
    if (event.agentRunId == null) continue;
    // question | plan | tasks — only the master can resolve these.
    return {
      kind: 'attention',
      event: { kind: event.kind, agentRunId: event.agentRunId, role: event.role },
    };
  }
  return { kind: 'all_done' };
}
