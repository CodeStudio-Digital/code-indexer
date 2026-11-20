/**
 * The end of a background child-agent run (requested without a wait) reaches
 * the parent as one durable mailbox message from the child, kind 'task' like
 * the network triggers' completion delivery, keyed by that run end so it is
 * never sent twice. The collaboration machinery then delivers it: a running
 * parent gets it at its next turn boundary (attachChatMailbox), an idle one is
 * woken (the wake service), and a message still queued after an app restart
 * is delivered by the same scan. The usage of the run is not in the message:
 * the parent's worker counts it from the child's bundle (ChildAgentUsageLedger).
 *
 * The app runs this when a run ends, at boot and on every wake-service scan;
 * it writes only the app's own files (mailbox, queue entry).
 *
 * A stopped background child tells its parent only when the user stopped the
 * child's own chat: once, as a 'notify' that reaches the parent at its next
 * turn or run without waking it (a wake could restart what the user stopped).
 * A child its parent or a higher ancestor stopped tells nobody: the parent
 * stopped it, or is stopped too.
 */
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { rootChatId, type ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import type { ChildAgentQueueStore } from './child-agent-queue-store.js';
import { formatChildAgentNotice } from './child-agent-result.js';
import { waitForChildAgents } from './child-agent-wait.js';

/** A notice outlives the default mailbox deadline: the longest one the mailbox allows. */
const NOTICE_DEADLINE_MS = 86_400_000;
const FINISHED = new Set(['completed', 'failed', 'cut_off', 'aborted']);

export interface ChildAgentNoticeDeps {
  queue: ChildAgentQueueStore;
  sessions: Pick<FsSessionStore, 'getChildAgentSession'>;
  refresh?(childId: string): Promise<unknown>;
  mailbox: Pick<ChatCollaborationStore, 'send'>;
  log?(message: string): void;
}

/** Sends the pending completion notices of `childIds` (every background child when omitted); returns the children notified. */
export async function deliverChildAgentCompletions(deps: ChildAgentNoticeDeps, childIds?: readonly string[]): Promise<string[]> {
  const entries = childIds ? await Promise.all(childIds.map((id) => deps.queue.get(id))) : await deps.queue.list();
  const notified: string[] = [];
  for (const entry of entries) {
    if (!entry.background || entry.state !== 'released' || !entry.released_at) continue;
    if (entry.notified_release_at === entry.released_at) continue;
    const releasedAt = entry.released_at;
    const markNotified = () => deps.queue.update(entry.child_id, (queue) => (queue.released_at !== releasedAt
      || queue.notified_release_at === releasedAt ? queue : { ...queue, notified_release_at: releasedAt }));
    const stopped = !!entry.stop_requested_at;
    if (stopped && String(entry.stopped_by).toLowerCase() !== entry.child_id.toLowerCase()) { await markNotified(); continue; }
    try {
      const child = await deps.sessions.getChildAgentSession(entry.child_id);
      if (!child || child.is_archived) continue;
      const { items: [item] } = await waitForChildAgents({ sessions: deps.sessions, queue: deps.queue, refresh: deps.refresh },
        { chatIds: [child.id], timeoutMs: 0 });
      if (!item || !FINISHED.has(item.status)) continue;
      await deps.mailbox.send({
        from: rootChatId(child.id), to: rootChatId(child.parent_session_id), kind: stopped ? 'notify' : 'task',
        idempotencyKey: `child-done:${item.runId ?? `${child.id}:${entry.released_at}`}`,
        body: formatChildAgentNotice(item), timeoutMs: NOTICE_DEADLINE_MS,
      }, { fromStopped: stopped }); // a stopped chat's mailbox refuses its agents, not this notice
      await markNotified();
      notified.push(child.id);
    } catch (error) {
      // A stopped or unlinked parent must not hold up the other notices; the next scan retries.
      (deps.log ?? console.warn)(`[child-agent] completion notice for ${entry.child_id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notified;
}
