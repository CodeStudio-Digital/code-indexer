/**
 * Stopping child agents. A stop covers its target and every descendant: live
 * runs are aborted in the worker pool, queued ones are cancelled, and their
 * pending questions and tasks leave the mailbox, which then refuses new
 * messages to them. The intent is durable before anything else happens: a
 * stop record in the app's files (the cascade still to finish) and a stop mark
 * on each queue entry (never admitted, re-handed or woken again). A restarted
 * app finishes every recorded stop before it resumes any tree. Stopping is
 * idempotent: a child already marked keeps its first mark.
 *
 * Authority: through the port, only a strict ancestor in the same tree stops
 * a chat. The user's Stop and a session's archive or deletion stop that
 * session's descendants, and the session itself when it is a child agent.
 * Only the app's own files are written; child bundles are left to their workers.
 */
import { randomUUID } from 'node:crypto';
import type { CollaborationFiles } from '@mcp/session-storage/collaboration/files.js';
import type { ChildAgentAdmission } from './child-agent-admission.js';
import type { ChildAgentQueueStore } from './child-agent-queue-store.js';
import { childAgentDescendants, type ChildAgentTreeStore } from './child-agent-tree.js';

const CHILD_AGENT_STOPS_KIND = 'child-agent-stops';

/** Why a child stopped: an ancestor's stop, the user's Stop, or the archive or deletion of the session or an ancestor. */
export type ChildAgentStopReason = 'stopped_by_parent' | 'stopped_by_user' | 'session_archived' | 'session_deleted';

export class ChildAgentStopRefused extends Error {
  constructor(readonly chatId: string, readonly code: 'not_a_child_agent' | 'not_an_ancestor') {
    super(code === 'not_a_child_agent'
      ? `Chat ${chatId} is not a child agent`
      : `Only an ancestor in the same tree can stop chat ${chatId}`);
    this.name = 'ChildAgentStopRefused';
  }
}

interface ChildAgentStopRecord {
  id: string;
  target_id: string;
  origin_id: string;
  reason: ChildAgentStopReason;
  requested_at: string;
}

export interface ChildAgentStopDeps {
  sessions: ChildAgentTreeStore;
  queue: ChildAgentQueueStore;
  /** The app's collaboration files: the record of each stop still to finish. */
  files: Pick<CollaborationFiles, 'ensure' | 'put' | 'list' | 'remove'>;
  admission: Pick<ChildAgentAdmission, 'release'>;
  /** Whether a child's run is live in this app (the worker pool). */
  isRunning(childId: string): boolean;
  /** Aborts a child's live run; a no-op when none is live. */
  abort(childId: string): Promise<void>;
  /** Cancels the child's pending questions and tasks and makes the mailbox refuse new messages to it. */
  closeMailbox(childId: string): Promise<void>;
  /** Starts what the tree of `sessionId` may run now (the next queued child). */
  pump(sessionId: string): Promise<void>;
  now?(): Date;
  log?(message: string): void;
}

const lower = (id: unknown) => String(id).toLowerCase();

export class ChildAgentStops {
  readonly #deps: ChildAgentStopDeps;
  #ready: Promise<void> | null = null;

  constructor(deps: ChildAgentStopDeps) { this.#deps = deps; }

  #now() { return (this.#deps.now?.() ?? new Date()).toISOString(); }
  #ensure() { return (this.#ready ??= this.#deps.files.ensure(CHILD_AGENT_STOPS_KIND)); }

  async #ancestors(chatId: string): Promise<string[]> {
    const chain: string[] = [];
    let current = chatId;
    for (let step = 0; step < 16; step++) {
      const child = await this.#deps.sessions.getChildAgentSession(current);
      if (!child) return chain;
      chain.push(lower(child.parent_session_id));
      current = child.parent_session_id;
    }
    throw new Error(`Child-agent ancestry of ${chatId} does not end`);
  }

  /**
   * Through the port: `callerId` stops `chatIds` and their descendants. Each
   * target must be a child agent with `callerId` among its ancestors: a child
   * never stops its parent, a sibling, itself or a chat of another tree.
   */
  async stopByAncestor(callerId: string, chatIds: readonly string[]): Promise<string[]> {
    for (const id of chatIds) {
      if (!await this.#deps.sessions.getChildAgentSession(id)) throw new ChildAgentStopRefused(id, 'not_a_child_agent');
      if (!(await this.#ancestors(id)).includes(lower(callerId))) throw new ChildAgentStopRefused(id, 'not_an_ancestor');
    }
    const stopped = new Set<string>();
    for (const id of chatIds) {
      for (const done of await this.#begin(id, callerId, 'stopped_by_parent')) stopped.add(done);
    }
    return [...stopped];
  }

  /** The user's Stop, or the archive or deletion of `sessionId`. */
  stopSession(sessionId: string, reason: Exclude<ChildAgentStopReason, 'stopped_by_parent'>): Promise<string[]> {
    return this.#begin(sessionId, sessionId, reason);
  }

  /** Boot, before any tree resumes: finishes every stop the app had begun. */
  async resume(): Promise<number> {
    await this.#ensure();
    const records = await this.#deps.files.list<ChildAgentStopRecord>(CHILD_AGENT_STOPS_KIND);
    for (const record of records.sort((a, b) => a.requested_at.localeCompare(b.requested_at))) await this.#apply(record);
    return records.length;
  }

  async #begin(targetId: string, originId: string, reason: ChildAgentStopReason): Promise<string[]> {
    await this.#ensure();
    const record: ChildAgentStopRecord = { id: randomUUID(), target_id: targetId, origin_id: originId, reason, requested_at: this.#now() };
    await this.#deps.files.put(CHILD_AGENT_STOPS_KIND, record.id, record); // the intent, before anything else
    return this.#apply(record);
  }

  async #apply(record: ChildAgentStopRecord): Promise<string[]> {
    const { sessions, queue } = this.#deps;
    const ids: string[] = [];
    // The target itself when it is a child agent (a root is not in the queue).
    if (await sessions.getChildAgentSession(record.target_id)) ids.push(record.target_id);
    for (const child of await childAgentDescendants(sessions, record.target_id)) ids.push(child.id);
    // 1. The mark first: from here on none of them is admitted, re-handed or woken.
    for (const id of ids) {
      await queue.update(id, (entry) => (entry.stop_requested_at ? entry : {
        ...entry, stop_requested_at: record.requested_at, stopped_by: record.origin_id, stop_reason: record.reason,
        ...(entry.state === 'queued' ? { state: 'released' as const, released_at: this.#now(), release_reason: 'stopped' } : {}),
      }));
    }
    let failed = false;
    const step = async (id: string, what: string, action: () => Promise<void>) => {
      try { await action(); } catch (error) {
        failed = true; // the record stays: the next boot finishes the stop
        (this.#deps.log ?? console.warn)(`[child-agent] stop of ${id}: ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // 2. Pending questions and tasks leave the mailbox; new messages to them are refused.
    for (const id of ids) await step(id, 'mailbox', () => this.#deps.closeMailbox(id));
    // 3. Live runs end; the end of each gives its slot back as usual.
    for (const id of ids) await step(id, 'abort', () => this.#deps.abort(id));
    // 4. Admitted but not live (the app restarted mid-stop): the slot goes back now.
    for (const id of ids) if (!this.#deps.isRunning(id)) await this.#deps.admission.release(id, 'stopped');
    if (ids.length > 0) await step(record.target_id, 'next start', () => this.#deps.pump(record.target_id));
    if (!failed) await this.#deps.files.remove(CHILD_AGENT_STOPS_KIND, record.id);
    return ids;
  }
}
