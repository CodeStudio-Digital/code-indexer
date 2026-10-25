import type { SessionId } from '@mcp/agent-runtime-contracts';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';

/** Runs only through the worker's session store, which owns the writer lease. */
export async function materializePendingAgentTransition(
  store: FsSessionStore,
  sessionId: SessionId,
): Promise<void> {
  const transition = await store.consumePendingAgentTransition(sessionId);
  if (!transition) return;

  const from = transition.fromAgent ?? 'session-default';
  const to = transition.toAgent ?? 'session-default';
  const reminder =
    `<system-reminder>Agent transition: ${from} → ${to}. ` +
    `The active agent is now ${to}. Follow the current system prompt, behavior, ` +
    `tool rules, and mutation policy for this new agent. Earlier assistant claims ` +
    `about the active agent or mode are stale.</system-reminder>`;
  await store.appendMessage({
    session_id: sessionId,
    operation_id: `agent-transition:${transition.id}:message`,
    message: {
      role: 'user',
      content: [{ type: 'text', text: reminder }],
      isMeta: true,
    },
  });
  await store.recordSessionInput({
    session_id: sessionId,
    operation_id: `agent-transition:${transition.id}:input`,
    kind: 'system_reminder',
    source_label: 'reminder:agent-transition',
    content: reminder,
  });
}
