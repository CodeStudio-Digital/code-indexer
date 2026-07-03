/**
 * buildSessionIntent — compact "why these changes exist" block for the
 * snapshot_review context. Shared by every review entrypoint that has a
 * coder session id at hand: the `self_review` tool, the dashboard `/auto`
 * route, and the master `review_subordinate_work` tool (a subordinate's
 * first user message IS the task the master forwarded to it).
 *
 * Best-effort by design: any store failure returns null and the review
 * simply runs without intent. Size caps live here so all entrypoints send
 * the same-shaped block; the assembled context is capped again in
 * snapshot-review-context.ts / the pipeline.
 */
import type { SessionStore } from './store.js';

const MAX_FIRST_MSG_CHARS = 1_500;
const MAX_TASKS = 10;

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function buildSessionIntent(store: SessionStore, sessionId: number): string | null {
  try {
    const parts: string[] = [];

    const session = store.getSession(sessionId);
    if (session?.title) parts.push(`Session: ${session.title}`);

    const firstMsg = store.getFirstUserMessageText(sessionId);
    if (firstMsg) parts.push(`Original request:\n${cap(firstMsg, MAX_FIRST_MSG_CHARS)}`);

    const tasks = store.getTasksState(sessionId);
    if (tasks && tasks.tasks.length > 0) {
      const lines = tasks.tasks
        .slice(0, MAX_TASKS)
        .map((t) => `- [${t.status}] ${t.title || t.content || t.id}`);
      if (tasks.tasks.length > MAX_TASKS) {
        lines.push(`- ... (${tasks.tasks.length - MAX_TASKS} more)`);
      }
      const heading = tasks.summary ? `Task list — ${tasks.summary}:` : 'Task list:';
      parts.push(`${heading}\n${lines.join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  } catch {
    return null;
  }
}
