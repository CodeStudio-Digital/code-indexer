/**
 * Tree admission for child-agent runs: at most MAX_RUNNING_CHILDREN_PER_TREE
 * children of one root run at once, all levels counted; the rest wait in
 * creation order.
 *
 * The queue lives in the app's files (ChildAgentQueueStore); a child's bundle
 * is only read (its conclusion and run records), because its worker owns the
 * bundle's writer while it runs. Slots are never counted separately: every
 * admit() recounts the admitted children and reconciles each with what its
 * bundle says (a recorded conclusion or a finished run record gives the slot
 * back; a run record whose worker is gone frees it as interrupted) and with
 * isRunning. A restarted app rebuilds the queue from the same files.
 *
 * Lives with the app, which starts child runs in their own workers.
 */
import type { FsChildAgentSession, FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { childAgentDescendants, childAgentRoot, type ChildAgentTreeStore } from './child-agent-tree.js';
import type { ChildAgentQueueEntry, ChildAgentQueueStore } from './child-agent-queue-store.js';

export const MAX_RUNNING_CHILDREN_PER_TREE = 3;

/** Read-only access to the child bundles (catalog, conclusion, run records). */
export type ChildAgentAdmissionStore = ChildAgentTreeStore & Pick<FsSessionStore, 'listSubagentRuns'> & {
  /** Re-reads a child written by its own worker (another store instance). */
  refreshSession?(id: string): Promise<unknown>;
};

export interface ChildAgentAdmissionOptions {
  sessions: ChildAgentAdmissionStore;
  queue: ChildAgentQueueStore;
  /** Whether a child's run is live in this app (the worker pool). */
  isRunning?(childId: string): boolean;
  maxRunning?: number;
  now?(): Date;
}

/** A child the tree admitted and the app should start now. */
export interface ChildAgentAdmitted {
  id: string;
  child: FsChildAgentSession;
  queue: ChildAgentQueueEntry;
}

export class ChildAgentAdmission {
  readonly #options: ChildAgentAdmissionOptions;
  /** Returned by admit() in this process and not started yet: never handed out twice. */
  readonly #starting = new Set<string>();
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: ChildAgentAdmissionOptions) { this.#options = options; }

  get queue(): ChildAgentQueueStore { return this.#options.queue; }

  #now() { return (this.#options.now?.() ?? new Date()).toISOString(); }

  /** One admission at a time per tree, inside this app. */
  #locked<T>(rootId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(rootId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.#locks.set(rootId, run.catch(() => undefined));
    return run;
  }

  /**
   * Asks for a run that starts with `task`: an idle or released child joins the
   * queue; a queued or admitted one stays as it is (its task included). A
   * stopped child stays stopped unless `restart` (an ancestor's explicit new
   * start) is set, and only once its stopped run has ended.
   */
  request(childId: string, task: string | null = null, options: { background?: boolean; restart?: boolean } = {}): Promise<ChildAgentQueueEntry> {
    return this.#options.queue.update(childId, (queue) => {
      if (queue.state === 'queued' || queue.state === 'admitted') return queue;
      if (queue.stop_requested_at && !options.restart) return queue;
      return { ...queue, state: 'queued', requested_at: this.#now(), admitted_at: null, released_at: null, release_reason: null, release_detail: null, task,
        background: options.background === true, stop_requested_at: null, stopped_by: null, stop_reason: null };
    });
  }

  /** Takes a queued child out of the queue; false when it already holds a slot or finished. */
  async cancel(childId: string): Promise<boolean> {
    const next = await this.#options.queue.update(childId, (queue) => (queue.state !== 'queued' ? queue
      : { ...queue, state: 'released', released_at: this.#now(), release_reason: 'cancelled' }));
    return next.state === 'released' && next.release_reason === 'cancelled';
  }

  /** Gives the slot back when a child's run ends (completed, failed or aborted); `detail` says why it failed. */
  async release(childId: string, reason: string, detail?: string): Promise<void> {
    this.#starting.delete(childId.toLowerCase());
    await this.#options.queue.update(childId, (queue) => (queue.state === 'admitted' || queue.state === 'queued'
      ? { ...queue, state: 'released', released_at: this.#now(), release_reason: reason, release_detail: detail ?? null } : queue));
  }

  /** Admits as many queued children as the tree has free slots; returns every child to start now. */
  admit(sessionId: string): Promise<ChildAgentAdmitted[]> {
    return childAgentRoot(this.#options.sessions, sessionId).then((rootId) => this.#locked(rootId, () => this.#admit(rootId)));
  }

  /** Why an admitted child no longer holds its slot, or null while it does. */
  async #ended(child: FsChildAgentSession, queue: ChildAgentQueueEntry, live: boolean): Promise<string | null | 'unstarted'> {
    if (child.is_archived) return 'orphaned';
    const since = queue.admitted_at ?? '';
    // The child concluded (the app may have died before it released the slot).
    if (child.conclusion && child.conclusion.finished_at >= since) return child.conclusion.reason;
    const run = (await this.#options.sessions.listSubagentRuns(child.id, 0, 50)).items
      .filter((row) => row.started_at >= since)
      .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
    if (run && run.status !== 'running') return run.reason ?? run.status;
    if (run && !live) return 'interrupted';
    if (run) this.#starting.delete(String(child.id).toLowerCase());
    return run || live ? null : 'unstarted';
  }

  async #admit(rootId: string): Promise<ChildAgentAdmitted[]> {
    const { sessions, queue } = this.#options;
    const max = this.#options.maxRunning ?? MAX_RUNNING_CHILDREN_PER_TREE;
    const tree = await childAgentDescendants(sessions, rootId);
    const entries = await Promise.all(tree.map((child) => queue.get(child.id)));
    const toStart: ChildAgentAdmitted[] = [];
    let holding = 0;
    for (const [index, child] of tree.entries()) {
      const entry = entries[index]!;
      if (entry.state !== 'admitted') continue;
      await sessions.refreshSession?.(child.id);
      const fresh = (await sessions.getChildAgentSession(child.id)) ?? child;
      const ended = await this.#ended(fresh, entry, this.#options.isRunning?.(child.id) === true);
      if (ended && ended !== 'unstarted') { await this.release(child.id, ended); continue; }
      // Stopped while admitted and not live (e.g. the app restarted mid-stop): never started again.
      if (entry.stop_requested_at && ended === 'unstarted') { await this.release(child.id, 'stopped'); continue; }
      holding++;
      const key = String(child.id).toLowerCase();
      // Admitted but never started (e.g. the app restarted between admit and start): start it.
      if (ended === 'unstarted' && !this.#starting.has(key)) { this.#starting.add(key); toStart.push({ id: child.id, child: fresh, queue: entry }); }
    }
    for (const [index, child] of tree.entries()) {
      if (holding >= max) break;
      if (entries[index]!.state !== 'queued') continue;
      if (entries[index]!.stop_requested_at) { await this.release(child.id, 'stopped'); continue; }
      // Archiving happens elsewhere (the user, the child's worker): re-read first.
      await sessions.refreshSession?.(child.id);
      if ((await sessions.getChildAgentSession(child.id))?.is_archived ?? true) { await this.release(child.id, 'orphaned'); continue; }
      const admitted = await queue.update(child.id, (current) => (current.state !== 'queued' || current.stop_requested_at ? current
        : { ...current, state: 'admitted', admitted_at: this.#now() }));
      if (admitted.state !== 'admitted') continue;
      holding++;
      this.#starting.add(String(child.id).toLowerCase());
      toStart.push({ id: child.id, child, queue: admitted });
    }
    return toStart;
  }
}
