/**
 * active-agent-registry — process-level index of RUNNING ephemeral subagents
 * (spawn_agent single/parallel, execute_tasks waves, workflow steps) so a
 * specific agent can be aborted individually — from the dashboard (HTTP
 * route) or a future tool — without killing the whole run.
 *
 * Each dispatcher registers one AbortController per agent under its
 * (sessionId, groupId, agentIndex) coordinates — the same identity the
 * agents_group_start/agent_progress events carry, so UI rows map 1:1.
 * Module-global-per-realm like the resume registry: abort is only
 * meaningful while the process that runs the agents is alive.
 */

export interface ActiveAgentEntry {
  sessionId: number;
  groupId: string;
  agentIndex: number;
  label: string;
  startedAt: number;
}

interface ActiveAgent extends ActiveAgentEntry {
  controller: AbortController;
}

const byKey = new Map<string, ActiveAgent>();

function keyOf(sessionId: number, groupId: string, agentIndex: number): string {
  return `${sessionId}:${groupId}:${agentIndex}`;
}

/**
 * Register a running agent. Returns an unregister fn — call it in a
 * `finally` when the agent settles so aborts can't hit a recycled slot.
 */
export function registerActiveAgent(
  sessionId: number | undefined,
  groupId: string,
  agentIndex: number,
  label: string,
  controller: AbortController,
): () => void {
  if (sessionId == null) return () => {};
  const key = keyOf(sessionId, groupId, agentIndex);
  byKey.set(key, { sessionId, groupId, agentIndex, label, startedAt: Date.now(), controller });
  return () => { byKey.delete(key); };
}

/**
 * Abort one agent by index or label. Returns the entry it aborted, or null
 * when nothing matched (already finished, wrong ref).
 */
export function abortActiveAgent(
  sessionId: number,
  groupId: string,
  agentRef: number | string,
): ActiveAgentEntry | null {
  for (const agent of byKey.values()) {
    if (agent.sessionId !== sessionId || agent.groupId !== groupId) continue;
    const matches = typeof agentRef === 'number'
      ? agent.agentIndex === agentRef
      : agent.label === agentRef;
    if (!matches) continue;
    try { agent.controller.abort(new Error('aborted by user')); } catch { /* ignore */ }
    byKey.delete(keyOf(agent.sessionId, agent.groupId, agent.agentIndex));
    const { controller: _controller, ...entry } = agent;
    return entry;
  }
  return null;
}

/** All running agents for a session (dashboard uses events; this is for routes/tests). */
export function listActiveAgents(sessionId: number): ActiveAgentEntry[] {
  const out: ActiveAgentEntry[] = [];
  for (const agent of byKey.values()) {
    if (agent.sessionId !== sessionId) continue;
    const { controller: _controller, ...entry } = agent;
    out.push(entry);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
