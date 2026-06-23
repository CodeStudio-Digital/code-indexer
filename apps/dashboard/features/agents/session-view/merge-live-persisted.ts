/**
 * Merge helpers — reconcile the persisted REST snapshot with the live SSE
 * stream state for a company session.
 *
 * The Agents view has two sources of truth for the board and the agents
 * list: the initial `/company/sessions/:id` fetch (durable history) and
 * the live meta-bus stream (incremental events). Rendering EITHER one
 * exclusively is the bug these helpers fix — switching wholesale to the
 * live list the instant the first event arrives makes the board collapse
 * to "the latest" and drops persisted agents. Merging keeps both: history
 * is preserved and live events add on top, deduped by their stable id.
 *
 * Both functions are pure so they can be unit-tested in isolation and
 * memoised by the caller.
 */
import type { AgentRunStatus } from '@mcp/company-contracts';
import type { AgentStreamState, BoardMessage } from '../../../state/company/types.js';
import type { PersistedAgentRun } from './types.js';

/**
 * Union of persisted + live board messages keyed by `id`. Live entries win
 * on conflict (they carry the freshest content for a replayed row).
 * `BoardPanel` sorts by `created_at` itself, so order here is irrelevant —
 * the only contract is "no duplicate ids" (BoardPanel keys on `m-${id}`).
 */
export function mergeBoardMessages(
  persisted: BoardMessage[],
  live: BoardMessage[],
): BoardMessage[] {
  const byId = new Map<number, BoardMessage>();
  for (const m of persisted) byId.set(m.id, m);
  for (const m of live) byId.set(m.id, m);
  return Array.from(byId.values());
}

/**
 * Union of persisted agent runs + live subordinate states keyed by
 * `agentRunId`. The master is excluded (it lives in `stream.masterState`).
 *
 * Persisted runs seed the list so agents from prior turns / a recovered
 * session stay visible even when no event is currently streaming for them.
 * Live state overlays (it has the running status, tool calls, activity
 * pill) but we preserve the persisted `coderSessionId` when the live seed
 * lacks it — that id is what makes the row clickable.
 */
export function mergeSubordinates(
  persisted: PersistedAgentRun[],
  live: Map<number, AgentStreamState>,
): AgentStreamState[] {
  const byId = new Map<number, AgentStreamState>();
  for (const run of persisted) {
    if (run.role === 'master') continue;
    byId.set(run.id, {
      role: run.role,
      agentRunId: run.id,
      coderSessionId: run.coder_session_id,
      textChunks: [],
      toolCalls: [],
      status: run.status as AgentRunStatus,
    });
  }
  for (const [id, liveState] of live) {
    const seed = byId.get(id);
    byId.set(id, {
      ...liveState,
      coderSessionId: liveState.coderSessionId ?? seed?.coderSessionId,
    });
  }
  return Array.from(byId.values()).sort((a, b) => a.agentRunId - b.agentRunId);
}
