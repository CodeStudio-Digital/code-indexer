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
type Awaitable<T> = T | Promise<T>;

export interface SessionIntentStore<SessionKey extends string = string> {
  getSession(sessionId: SessionKey): Awaitable<{ title?: string | null } | null>;
  getFirstUserMessageText(sessionId: SessionKey): Awaitable<string | null>;
  getLatestNonMetaUserMessageText(sessionId: SessionKey): Awaitable<string | null>;
  listPlans(sessionId: SessionKey): Awaitable<
    Array<{ status: string; plan_text: string }>
  >;
  getTasksState(sessionId: SessionKey): Awaitable<{
    summary?: string | null;
    tasks: Array<{
      id: string;
      status: string;
      title?: string | null;
      content?: string | null;
    }>;
  } | null>;
}

const MAX_FIRST_MSG_CHARS = 1_500;
const MAX_PLAN_CHARS = 2_000;
const MAX_TASKS = 10;

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export async function buildSessionIntent<SessionKey extends string>(
  store: SessionIntentStore<SessionKey>,
  sessionId: SessionKey,
): Promise<string | null> {
  try {
    const parts: string[] = [];

    const session = await store.getSession(sessionId);
    if (session?.title) parts.push(`Session: ${session.title}`);

    const firstMsg = await store.getFirstUserMessageText(sessionId);
    if (firstMsg) parts.push(`Original request:\n${cap(firstMsg, MAX_FIRST_MSG_CHARS)}`);

    // A pivot changes the human's intent mid-session; surface the latest
    // non-meta request so the review evaluates against the CURRENT ask, not
    // only the first message. Skip when it is identical to the original.
    const latestMsg = await store.getLatestNonMetaUserMessageText(sessionId);
    if (latestMsg && latestMsg.trim() !== (firstMsg ?? '').trim()) {
      parts.push(`Latest request:\n${cap(latestMsg, MAX_FIRST_MSG_CHARS)}`);
    }

    // The approved plan is the contract the diff is expected to fulfill. The
    // newest plan row wins (listPlans is DESC); only an approved plan counts —
    // a pending/rejected one is not an obligation source.
    const latestPlan = (await store.listPlans(sessionId))[0];
    if (latestPlan && latestPlan.status === 'approved' && latestPlan.plan_text.trim()) {
      parts.push(`Approved plan:\n${cap(latestPlan.plan_text, MAX_PLAN_CHARS)}`);
    }

    const tasks = await store.getTasksState(sessionId);
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
