/**
 * MasterAttention — a tiny event signal that wakes `wait_for_subordinates`
 * in real time whenever a subordinate needs the master's attention.
 *
 * The master's `wait_for_subordinates` tool used to busy-poll every 3s and
 * only returned when all subordinates finished. A subordinate in
 * `waiting_question` state still counts as running, so the master stayed
 * deaf to questions until the subordinate actually completed (or the
 * 30-minute timeout expired). Meanwhile `pushUserMessage` had already
 * enqueued the notification — but the master never got to consume it.
 *
 * With this signal, the tool awaits an event instead of sleeping. The 4
 * kinds of events are emitted from the exact points that previously
 * needed the master's attention:
 *   - `question` — subordinate called `ask_master`
 *   - `plan`     — subordinate submitted a plan for approval
 *   - `tasks`    — subordinate submitted a task list for approval
 *   - `finished` — subordinate transitioned to a terminal status
 *                  (completed/error/aborted)
 *
 * On `question` / `plan` / `tasks` the tool returns immediately so the
 * master runs a turn and consumes the `pushUserMessage` queued by
 * `HumanInTheLoop.master.notify(...)`. On `finished` the tool re-checks
 * `hasRunningSubordinates()` so the final "all done" branch still fires.
 */

/**
 * V2 adds `inbox_answered` so the InboxQueue can wake a sender that
 * called `send_to_agent(wait=true)`. The signal carries the sender's
 * own `agentRunId` (the run waiting on the answer) — listeners filter
 * by that id to ignore other agents' inbox traffic.
 *
 * V3 adds `user_message`: the human sent a message while the master was
 * blocked in `wait_for_subordinates`. The message is already queued in the
 * runner's pendingUserMessages buffer; this signal wakes the wait loop so
 * the master runs a turn, reads/answers it, then resumes waiting. Carries
 * the master's own `agentRunId` and `role: 'human'`.
 *
 * V4 adds `notify`: a generic "a message was just pushed to the master's
 * queue, wake up, RETURN and run a turn". Emitted by `MasterLifecycle.notify`
 * for EVERY subordinate notification (plan/question/tasks/inbox/auto-continue)
 * so a master parked in `wait_for_subordinates` actually wakes — `notify`
 * itself only queues via `pushUserMessage` and can't break that event loop.
 * Distinct from `finished` (which makes the wait re-check the loop WITHOUT
 * returning) and `user_message` (human-specific, ignored by the permanent
 * listener). Carries the master's own `agentRunId` and `role: 'system'`.
 */
export type AttentionKind =
  | 'question' | 'plan' | 'tasks' | 'finished' | 'inbox_answered' | 'user_message' | 'notify';

export interface AttentionEvent {
  kind: AttentionKind;
  agentRunId: number;
  role: string;
}

export type AttentionListener = (ev: AttentionEvent) => void;

export class MasterAttention {
  private readonly listeners = new Set<AttentionListener>();

  /**
   * Subscribe to attention events. Returns an unsubscribe function.
   * Callers must unsubscribe on every exit path (resolve, timeout, reject)
   * to avoid dangling references.
   */
  on(listener: AttentionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  signal(ev: AttentionEvent): void {
    for (const l of this.listeners) {
      try { l(ev); } catch { /* swallow — listeners must not break signalers */ }
    }
  }
}
