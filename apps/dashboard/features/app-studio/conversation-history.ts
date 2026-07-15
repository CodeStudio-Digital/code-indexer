import type { CoderSession } from '../chat/types.js';

/** Keep the guided history scoped to this app's coordinator conversations. */
export function appStudioConversations(
  sessions: CoderSession[] | null,
  coordinatorSessionId: number | null,
): CoderSession[] {
  return (sessions ?? []).filter((session) => (
    session.agent === 'app_orchestrator' || session.id === coordinatorSessionId
  ));
}
