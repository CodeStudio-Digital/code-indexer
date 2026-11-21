/**
 * Starts child-agent runs through the tree admission and keeps the queue
 * moving: a requested child is admitted when its tree has a free slot, the
 * launcher starts its run in its own worker, and the end of a run releases
 * the slot and starts the next one. At boot, every tree with queued or
 * admitted children is resumed.
 *
 * Starting is idempotent: each start carries a key derived from the admission
 * (child id + admitted_at). The launcher deduplicates on it (the host's local
 * command admission), so a child handed out again after a restart never runs
 * twice, and an admitted child whose run already started is never restarted.
 */
import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { ChildAgentAdmission, ChildAgentAdmitted } from './child-agent-admission.js';
import type { ChildAgentQueueEntry } from './child-agent-queue-store.js';
import { childAgentRoot } from './child-agent-tree.js';

export interface ChildAgentLauncher {
  /** Whether the child's run is live in this host (the worker pool). */
  isRunning(childId: string): boolean;
  /**
   * Starts the child's run with `task` as its message. Must be idempotent per
   * `startKey`: a key it already accepted is a no-op.
   */
  start(input: { childId: string; task: string; startKey: string }): Promise<void>;
}

export type ChildAgentRunStore = Pick<FsSessionStore, 'getChildAgentSession' | 'listChildAgentSessions'>;

/** Longest failure text kept for the waiting parent. */
const FAILURE_TEXT_MAX = 500;

/** "<what>: <message>", bounded: why a child's start or run failed, for the log and the parent. */
export function failureReason(what: string, error: unknown): string {
  const message = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').trim();
  return (message && message !== what ? `${what}: ${message}` : what).slice(0, FAILURE_TEXT_MAX);
}

export function childAgentStartKey(childId: string, queue: Pick<ChildAgentQueueEntry, 'admitted_at'>): string {
  return `child-agent:${childId}:${queue.admitted_at ?? 'unadmitted'}`;
}

export class ChildAgentRunService {
  constructor(private readonly deps: {
    sessions: ChildAgentRunStore;
    admission: ChildAgentAdmission;
    launcher: ChildAgentLauncher;
    log?: (message: string) => void;
  }) {}

  #log(message: string) { (this.deps.log ?? console.warn)(`[child-agent] ${message}`); }

  /**
   * Queues a run of `childId` that starts with `task`, then starts what its
   * tree can run. `background`: nobody waits; the parent gets a notice.
   * `restart`: an ancestor's explicit new start of a stopped child.
   */
  async request(childId: string, task: string, options: { background?: boolean; restart?: boolean } = {}): Promise<ChildAgentQueueEntry> {
    await this.deps.admission.request(childId, task, options);
    await this.pump(childId);
    return this.deps.admission.queue.get(childId);
  }

  /**
   * An explicit next run of `childId` with `task` (also after a stop). A run
   * that just concluded may still hold its slot for a moment: wait up to
   * `settleMs` for it to give it back. Null when the child is still running.
   */
  async requestNext(childId: string, task: string, options: { background?: boolean } = {}, settleMs = 5_000): Promise<ChildAgentQueueEntry | null> {
    const deadline = Date.now() + settleMs;
    for (;;) {
      const before = new Date().toISOString();
      const entry = await this.request(childId, task, { ...options, restart: true });
      if ((entry.requested_at ?? '') >= before) return entry;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Admits and starts every child the tree of `sessionId` may run now. */
  async pump(sessionId: string): Promise<void> {
    await this.#startAdmitted(await this.deps.admission.admit(sessionId));
  }

  /** Return once the task is durable and its tree has assigned slots. Worker startup can take much longer. */
  async requestBackground(childId: string, task: string, restart: boolean): Promise<void> {
    await this.deps.admission.request(childId, task, { background: true, restart });
    const admitted = await this.deps.admission.admit(childId);
    void this.#startAdmitted(admitted).catch(error => this.#log(`dispatch of ${childId} failed: ${failureReason('dispatch_failed', error)}`));
  }

  async #startAdmitted(admitted: ChildAgentAdmitted[]): Promise<void> {
    for (const child of admitted) {
      const task = child.queue.task?.trim();
      if (!task) {
        // Nothing to run: give the slot back instead of holding it forever.
        await this.deps.admission.release(child.id, 'no_task');
        continue;
      }
      try {
        await this.deps.launcher.start({ childId: child.id, task, startKey: childAgentStartKey(child.id, child.queue) });
      } catch (error) {
        const reason = failureReason('start_failed', error);
        this.#log(`start of ${child.id} failed: ${reason}`);
        await this.deps.admission.release(child.id, 'start_failed', reason);
      }
    }
  }

  /** The child's run ended (completed, failed, cut off or aborted): free its slot, start the next. */
  async ended(childId: string, reason: string, detail?: string): Promise<void> {
    await this.deps.admission.release(childId, reason, detail);
    await this.pump(childId);
  }

  /**
   * Boot: resume every tree that still has queued or admitted children. An
   * entry whose child session is gone or archived is released as orphaned, so
   * it never holds a slot.
   */
  async resume(): Promise<number> {
    const roots = new Set<string>();
    for (const entry of await this.deps.admission.queue.list()) {
      if (entry.state !== 'queued' && entry.state !== 'admitted') continue;
      const child = await this.deps.sessions.getChildAgentSession(entry.child_id);
      if (!child || child.is_archived) { await this.deps.admission.release(entry.child_id, 'orphaned'); continue; }
      roots.add(await childAgentRoot(this.deps.sessions, child.id));
    }
    for (const root of roots) {
      try { await this.pump(root); } catch (error) {
        this.#log(`resume of tree ${root} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return roots.size;
  }
}
