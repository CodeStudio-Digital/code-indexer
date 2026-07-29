/**
 * await-master — safety deadline around a subordinate's blocking wait for a
 * Master decision (`ask_master`, `submit_plan_to_master`,
 * `submit_tasks_to_master`).
 *
 * Those tools post an event to the Master and then `await
 * runner.waitForUserInput()`. If the Master never responds — it crashed, or
 * ended its turn and was never resurrected, AND the AgentSupervisor is
 * disabled — the subordinate blocks FOREVER: it is parked inside the tool
 * call, not advancing turns, so `maxTurns` can't rescue it. That is the
 * single worst "travamento" a subordinate can hit.
 *
 * This adds a generous deadline. When it elapses we resolve the SAME pending
 * input slot with an `interrupted` sentinel (the established interrupt
 * protocol, see CoderRunner.interruptWait), which both unblocks the awaiting
 * tool and clears the slot from the runner — no leak, no double-resolve. The
 * tool then returns an error telling the subordinate to proceed on its own.
 *
 * The default (30 min) is far longer than a healthy Master takes to answer,
 * so it never fires in normal operation. When the supervisor is enabled it
 * acts first (forceResumeSubordinate / resurrectMaster); this is the fallback
 * for when it is off. Tunable via `MCP_SUBORDINATE_MASTER_WAIT_MS`.
 */

import { getGlobalAgentSupervisor } from '@mcp/company/services/supervisor/global.js';
import { asAgentRunId, type AgentRunId } from '@mcp/session-storage';

/** Minimal structural slice of CoderRunner this helper needs. */
export interface MasterWaitRunner {
  waitForUserInput(askId?: string): Promise<string>;
  isWaitingForInput(askId?: string): boolean;
  provideUserInput(value: string, askId?: string): boolean;
}

const DEFAULT_MASTER_WAIT_MS = 30 * 60 * 1000;
/** Heartbeat cadence while blocked on the master — well under the supervisor's
 *  ~5min stuck-tool timeout so a legitimate wait is never flagged/aborted. */
const MASTER_WAIT_HEARTBEAT_MS = 30_000;

export function resolveMasterWaitMs(): number {
  const raw = Number(process.env.MCP_SUBORDINATE_MASTER_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MASTER_WAIT_MS;
}

/** Sentinel resolved into the slot when the Master doesn't answer in time. */
export const MASTER_WAIT_TIMEOUT = {
  interrupted: true,
  reason: 'master_unavailable' as const,
};

/**
 * Await the Master's decision with a safety deadline. Returns the raw string
 * the Master provided, OR the JSON sentinel string when the deadline elapses
 * first. Always clears its timer.
 */
export async function awaitMasterDecision(
  runner: MasterWaitRunner,
  opts: { heartbeatAgentRunId?: AgentRunId | string } = {},
): Promise<string> {
  const timeoutMs = resolveMasterWaitMs();
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    // Resolve the default slot the tool is awaiting — provideUserInput is a
    // no-op if the Master already answered (slot cleared), so this can't
    // double-resolve or stomp a real answer that lands first.
    if (runner.isWaitingForInput()) {
      runner.provideUserInput(JSON.stringify(MASTER_WAIT_TIMEOUT));
    }
  }, timeoutMs);
  // Don't keep the event loop alive just for this deadline.
  const t = timer as { unref?: () => void } | null;
  if (t && typeof t.unref === 'function') t.unref();

  // Heartbeat the supervisor while blocked. Waiting for a master decision parks
  // the subordinate inside the `submit_plan_to_master`/`ask_master` tool call
  // (AWAITING_TOOL) with no `tool_progress` — so without this the supervisor
  // would flag a perfectly healthy wait as STUCK_TOOL and (now) reestablish/
  // abort it. No-op when the supervisor is off or the agent isn't tracked.
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (opts.heartbeatAgentRunId != null) {
    const id = asAgentRunId(String(opts.heartbeatAgentRunId));
    getGlobalAgentSupervisor()?.heartbeat(id);
    heartbeat = setInterval(() => { getGlobalAgentSupervisor()?.heartbeat(id); }, MASTER_WAIT_HEARTBEAT_MS);
    (heartbeat as { unref?: () => void }).unref?.();
  }

  try {
    return await runner.waitForUserInput();
  } finally {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
  }
}
