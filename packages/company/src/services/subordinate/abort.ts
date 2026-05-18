/**
 * Subordinate abort / abortAll / finalizeAll — the three "stop running
 * subordinates" entry points the master agent and the orchestrator
 * shutdown path reach for.
 *
 * Extracted from `SubordinateLifecycle` because the three methods
 * share the same teardown choreography (runner.abort → status flip →
 * attention signal) but apply it at different scopes:
 *
 *   - `abort(id)`    one subordinate; returns false when unknown.
 *   - `abortAll()`   every subordinate this lifecycle owns; clears maps.
 *   - `finalizeAll()` queries the company store for ALL runs (not just
 *                    in-memory), aborts what's running, marks the rest
 *                    completed, and clears HumanInTheLoop state. Used
 *                    by the master's `finalize_subordinates` tool.
 *
 * All three are pure orchestration — driver/persistence isn't touched
 * directly, only via the deps.
 */
import type { SubordinateHandle } from '@mcp/company/types.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type {
  IAgentStatusUpdater,
  IBoardPoster,
} from '@mcp/company/services/ports.js';

export interface SubordinateAbortDeps {
  ctx: SessionContext;
  board: IBoardPoster;
  status: IAgentStatusUpdater;
  humanInLoop: HumanInTheLoop;
  attention: MasterAttention;
  /** In-memory registry of running subordinates — mutated by abortAll/finalizeAll. */
  subordinates: Map<number, SubordinateHandle>;
  runningIds: Set<number>;
}

/**
 * Stop one subordinate. Returns false when the id is unknown (the
 * caller treats this as "nothing to abort"). Side effects:
 *   - runner.abort() — flushes pending tool calls.
 *   - clearForAgent() — releases any pending plan/question prompts.
 *   - status='aborted' on the agent_run row.
 *   - attention.signal('finished') — unblocks anyone waiting.
 *
 * Does NOT mutate `subordinates` / `runningIds` — the runner's
 * `.done.finally` (wired by `attachCompletionHandler`) does that.
 */
export function abortSubordinate(agentRunId: number, deps: SubordinateAbortDeps): boolean {
  const sub = deps.subordinates.get(agentRunId);
  if (!sub) return false;
  sub.runner.abort();
  deps.humanInLoop.clearForAgent(agentRunId);
  deps.status.setStatus(agentRunId, 'aborted');
  deps.attention.signal({ kind: 'finished', agentRunId, role: sub.role });
  return true;
}

/**
 * Abort every subordinate this lifecycle currently owns. Unlike
 * `finalizeAll`, this consults only the in-memory map — used by the
 * orchestrator's session-end / abort path where the runner state is
 * the only source of truth.
 *
 * Clears `subordinates` + `runningIds` so a subsequent `runningCount`
 * reads zero immediately, without waiting for each runner's `.done`
 * promise to settle.
 */
export function abortAllSubordinates(deps: SubordinateAbortDeps): void {
  for (const sub of deps.subordinates.values()) {
    try { sub.runner.abort(); } catch { /* best-effort */ }
    try { deps.status.setStatus(sub.agentRunId, 'aborted'); } catch { /* best-effort */ }
    deps.attention.signal({ kind: 'finished', agentRunId: sub.agentRunId, role: sub.role });
  }
  deps.subordinates.clear();
  deps.runningIds.clear();
}

export interface FinalizeAllResult {
  finalized: number;
  alreadyStopped: number;
}

/**
 * Gracefully terminate every non-master agent_run for the session.
 * Driven by the master agent's `finalize_subordinates` tool when the
 * orchestration is done.
 *
 * Steps:
 *   - Query `agent_runs` for the session (filtered to non-master).
 *   - Abort the running ones; count the rest as `alreadyStopped`.
 *   - Force status='completed' on every row (with "Finalized by master").
 *   - Signal attention.finished so any waiter unblocks.
 *   - Clear the in-memory maps + HumanInTheLoop registries.
 *   - Post a system message to the board with the count breakdown.
 */
export function finalizeAllSubordinates(deps: SubordinateAbortDeps): FinalizeAllResult {
  let finalized = 0;
  let alreadyStopped = 0;
  const runs = deps.ctx.companyStore.listAgentRuns(deps.ctx.companySessionId);
  const subs = runs.filter((r) => r.role !== 'master');

  for (const run of subs) {
    const handle = deps.subordinates.get(run.id);
    if (deps.runningIds.has(run.id) && handle) {
      try { handle.runner.abort(); } catch { /* best-effort */ }
      deps.runningIds.delete(run.id);
      finalized++;
    } else {
      alreadyStopped++;
    }
    try { deps.status.setStatus(run.id, 'completed', 'Finalized by master'); } catch { /* best-effort */ }
    deps.attention.signal({ kind: 'finished', agentRunId: run.id, role: run.role });
  }

  deps.subordinates.clear();
  deps.runningIds.clear();
  deps.humanInLoop.clearAll();
  deps.board.post(
    'system',
    null,
    'message',
    `All subordinates finalized: ${finalized} stopped, ${alreadyStopped} were already idle.`,
  );
  return { finalized, alreadyStopped };
}
