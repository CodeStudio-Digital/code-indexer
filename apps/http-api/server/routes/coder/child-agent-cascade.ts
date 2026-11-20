/**
 * How the session lifecycle routes outside the collaboration module reach the
 * child-agent host: the session Stop (/abort), archive and delete stop the
 * session's child agents through this. The collaboration routes set it when
 * they mount; before that there is no host and nothing to stop. A failed
 * cascade never blocks the route's own action: the stop record it left is
 * finished at the next boot.
 */
import type { ChildAgentStopReason } from '@mcp/code-agent/runtime/child-agent-stop.js';

type SessionStopReason = Exclude<ChildAgentStopReason, 'stopped_by_parent'>;
type Cascade = (sessionId: string, reason: SessionStopReason) => Promise<string[]>;

let cascade: Cascade | null = null;

export function setChildAgentCascade(next: Cascade | null): void {
  cascade = next;
}

/** Stops the child agents of `sessionId` (and itself when it is one); returns the chats it covered. */
export async function stopChildAgentsOf(sessionId: string, reason: SessionStopReason): Promise<string[]> {
  if (!cascade) return [];
  try {
    return await cascade(sessionId, reason);
  } catch (error) {
    console.warn(`[child-agent] stopping the child agents of ${sessionId} failed:`, error);
    return [];
  }
}
