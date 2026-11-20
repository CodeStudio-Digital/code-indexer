/**
 * A child-agent run paused on an approval prompt, told to its parent's chat
 * through the app-wide notification stream: the parent's per-session
 * notification center shows it with a way to open the child, and the notice
 * resolves when the prompt is answered or the run ends. The wait reads the
 * same state (awaiting_approval). A stop tells the session it came from how
 * many child chats it stopped, once per stop.
 */
import { asSessionId } from '@mcp/agent-runtime-contracts';
import { publishNotificationRuntimeEvent } from '../../../sse/notification-event-bus.js';

const CHILD_AGENT_ATTENTION_EVENT = 'child_agent_attention';
const CHILD_AGENTS_STOPPED_EVENT = 'child_agents_stopped';

interface ChildAgentAttentionData {
  childId: string;
  childTitle: string;
  /** The child's project, for the link that opens it (null: a global session). */
  projectId: number | null;
  state: 'awaiting_approval' | 'resolved';
}

export function childAgentAttention(publish: typeof publishNotificationRuntimeEvent = publishNotificationRuntimeEvent) {
  type Target = { parentId: string; childTitle: string; projectId: number | null };
  const pending = new Map<string, Target>();
  const send = (childId: string, target: Target, state: ChildAgentAttentionData['state']) => {
    publish({ kind: 'coder', sessionId: asSessionId(target.parentId), event: CHILD_AGENT_ATTENTION_EVENT,
      data: { childId, childTitle: target.childTitle, projectId: target.projectId, state } satisfies ChildAgentAttentionData });
  };
  return {
    awaiting: (childId: string) => pending.has(childId),
    request(childId: string, parentId: string, childTitle: string, projectId: number | null) {
      const target = { parentId, childTitle, projectId };
      pending.set(childId, target);
      send(childId, target, 'awaiting_approval');
    },
    resolve(childId: string) {
      const target = pending.get(childId);
      if (!target) return;
      pending.delete(childId);
      send(childId, target, 'resolved');
    },
    /** The session a stop came from learns how many child chats it covered. */
    stopped(originId: string, childIds: readonly string[], reason: string) {
      if (childIds.length === 0) return;
      publish({ kind: 'coder', sessionId: asSessionId(originId), event: CHILD_AGENTS_STOPPED_EVENT,
        data: { count: childIds.length, childIds: [...childIds], reason } });
    },
  };
}
