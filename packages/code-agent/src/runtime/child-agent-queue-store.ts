/**
 * The run queue of child agents, kept in the app's own collaboration files
 * (atomic writes, no session writer lease), never in a child's bundle. A
 * child's bundle belongs to its worker while it runs; the app only reads it.
 * Only the app writes these entries; it serializes updates per child.
 */
import type { CollaborationFiles } from '@mcp/session-storage/collaboration/files.js';

export interface ChildAgentQueueEntry {
  child_id: string;
  /** idle: never asked to run; queued: waits for a slot; admitted: holds one; released: gave it back. */
  state: 'idle' | 'queued' | 'admitted' | 'released';
  requested_at: string | null;
  admitted_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  /** Why a start or a run failed, with its message (shown to the waiting parent). */
  release_detail?: string | null;
  /** The message its next run starts with. */
  task: string | null;
  /** Requested without a wait: the parent hears of the end of the run through its mailbox. */
  background?: boolean;
  /** released_at of the last run end the parent was sent a completion notice for. */
  notified_release_at?: string | null;
  /**
   * Set when the child was stopped (ChildAgentStops): it is never admitted,
   * re-handed or woken again until an ancestor explicitly restarts it.
   */
  stop_requested_at?: string | null;
  /** The session whose stop reached this child: itself (the user stopped its chat), its parent or a higher ancestor. */
  stopped_by?: string | null;
  stop_reason?: string | null;
}

export interface ChildAgentQueueStore {
  get(childId: string): Promise<ChildAgentQueueEntry>;
  /** `update` returns the next entry, or the same object to leave it. */
  update(childId: string, update: (current: ChildAgentQueueEntry) => ChildAgentQueueEntry): Promise<ChildAgentQueueEntry>;
  list(): Promise<ChildAgentQueueEntry[]>;
}

export const CHILD_AGENT_QUEUE_KIND = 'child-agent-queue';

export function idleQueueEntry(childId: string): ChildAgentQueueEntry {
  return { child_id: childId, state: 'idle', requested_at: null, admitted_at: null, released_at: null, release_reason: null, task: null };
}

const key = (childId: string) => childId.toLowerCase();

export function fileChildAgentQueue(files: CollaborationFiles): ChildAgentQueueStore {
  const chains = new Map<string, Promise<unknown>>();
  let ready: Promise<void> | null = null;
  const ensure = () => (ready ??= files.ensure(CHILD_AGENT_QUEUE_KIND));
  const read = async (childId: string) => {
    await ensure();
    return (await files.get<ChildAgentQueueEntry>(CHILD_AGENT_QUEUE_KIND, key(childId))) ?? idleQueueEntry(childId);
  };
  return {
    get: read,
    update(childId, update) {
      const previous = chains.get(key(childId)) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(async () => {
        const current = await read(childId);
        const next = update(current);
        if (next !== current) await files.put(CHILD_AGENT_QUEUE_KIND, key(childId), { ...next, child_id: current.child_id });
        return next === current ? current : { ...next, child_id: current.child_id };
      });
      chains.set(key(childId), run);
      return run;
    },
    async list() {
      await ensure();
      return files.list<ChildAgentQueueEntry>(CHILD_AGENT_QUEUE_KIND);
    },
  };
}
