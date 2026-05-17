/**
 * InboxQueue — message queue between subordinate agents of a session.
 *
 * Use case: subordinate A has to ask subordinate B a question while B
 * is still busy on its own task. Without an inbox, A would have to go
 * up to the master, who would then forward to B, double-burning turns.
 *
 * Behaviour:
 *   - `send` writes a row to `agent_inbox` and tries to deliver
 *     immediately when the target is alive AND idle. Otherwise the
 *     row stays `pending`.
 *   - `drainOnIdle` is called by `SubordinateLifecycle` whenever a
 *     subordinate transitions to `waiting` (its task done). The queue
 *     atomically claims the next pending message for that agent and
 *     reactivates the runner with the message body so it shows up as
 *     a fresh user turn.
 *   - `respond` flips a delivered message to `answered` and signals
 *     `MasterAttention.inbox_answered` so a `wait=true` sender's
 *     `waitForAnswer` resolves.
 *   - `detectCycle` is a BFS over pending/delivered messages — used
 *     before insertion to refuse A→B when B already holds an open
 *     question targeted at A. Lets the sender get a structured error
 *     instead of a deadlock.
 *
 * A small in-memory mutex (per `agentRunId`) serialises `drainOnIdle`
 * vs other interleavings (master `forward_to_agent`, simultaneous
 * sends). The mutex stays in process — DB-level claims via
 * `claimNextInboxForAgent` cover the cross-process case anyway.
 */

import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type { SubordinateLifecycle } from '@mcp/company/services/SubordinateLifecycle.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import type { AgentInboxMessage, InboxKind, InboxStatus } from '@mcp/company/types.js';

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface InboxQueueDeps {
  ctx: SessionContext;
  subordinates: SubordinateLifecycle;
  attention: MasterAttention;
  publisher: IMetaBusPublisher;
}

export interface SendArgs {
  fromAgentRunId: number;
  fromRole: string;
  toRole?: string;
  toAgentRunId?: number;
  kind: InboxKind;
  body: string;
  /** When true the caller must follow up with `waitForAnswer(token)`. */
  wait: boolean;
}

export interface SendResult {
  message: AgentInboxMessage;
  /** True when the queue could route the message immediately (target idle). */
  deliveredImmediately: boolean;
  /** Set when `wait=true`; pass to `waitForAnswer` to resolve when answered. */
  waitToken?: string;
}

interface PendingWaiter {
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class InboxQueue {
  /** Per-token resolvers for `wait=true` senders. */
  private readonly waiters = new Map<string, PendingWaiter>();
  /** Per-`agentRunId` async mutex. Stored as a chain of promises. */
  private readonly drainMutexes = new Map<number, Promise<void>>();

  constructor(private readonly deps: InboxQueueDeps) {
    // Listen for `inbox_answered` so the sender's wait-promise resolves
    // even when the answer arrives while we're handling something else.
    this.deps.attention.on((ev) => {
      if (ev.kind !== 'inbox_answered') return;
      // ev.role here doubles as the wait_token via convention; see send().
      const token = ev.role;
      const waiter = this.waiters.get(token);
      if (!waiter) return;
      const msg = this.findMessageByWaitToken(token);
      if (!msg) return;
      clearTimeout(waiter.timer);
      this.waiters.delete(token);
      waiter.resolve(msg.answer ?? '');
    });
  }

  // ─── Send ─────────────────────────────────────────────────────

  send(args: SendArgs): SendResult {
    if (!args.toRole && typeof args.toAgentRunId !== 'number') {
      throw new Error('send_to_agent: pass either target_role or target_agent_run_id.');
    }

    if (this.detectCycle({
      fromAgentRunId: args.fromAgentRunId,
      toRole: args.toRole,
      toAgentRunId: args.toAgentRunId,
    })) {
      throw new Error(
        `Inbox cycle detected: target already holds a pending message back at @${args.fromRole}. ` +
          `Resolve indirectly via the master.`,
      );
    }

    const waitToken = args.wait ? makeToken() : undefined;
    const message = this.deps.ctx.companyStore.createInboxMessage({
      companySessionId: this.deps.ctx.companySessionId,
      fromAgentRunId: args.fromAgentRunId,
      fromRole: args.fromRole,
      toRole: args.toRole ?? null,
      toAgentRunId: args.toAgentRunId ?? null,
      kind: args.kind,
      body: args.body,
      waitToken: waitToken ?? null,
    });

    this.deps.publisher.publish('inbox_message_sent', {
      messageId: message.id,
      from: { agentRunId: args.fromAgentRunId, role: args.fromRole },
      to: { agentRunId: args.toAgentRunId ?? null, role: args.toRole ?? null },
      kind: args.kind,
    });

    // Try to deliver right now — the target may be idle. The drain
    // helper handles the actual reactivation; if the target is busy
    // the message stays `pending` and the next `drainOnIdle` (fired
    // when the target finishes its current task) picks it up.
    const targetRunId = this.resolveTargetRunId(message);
    if (targetRunId != null) {
      const targetStatus = this.deps.ctx.companyStore.getAgentRun(targetRunId)?.status;
      if (targetStatus && isIdleStatus(targetStatus)) {
        const role = this.deps.ctx.companyStore.getAgentRun(targetRunId)?.role ?? args.toRole ?? '';
        // Fire-and-forget: any failure stays a pending row that gets
        // delivered next time the target actually goes idle.
        void this.drainOnIdle(targetRunId, role);
        return { message, deliveredImmediately: true, waitToken };
      }
    }

    return { message, deliveredImmediately: false, waitToken };
  }

  /**
   * Block until either the message is answered or the timeout fires.
   * Resolves with the answer text, rejects with a timeout error
   * (rows flip to `expired` when that happens).
   */
  waitForAnswer(token: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const w = this.waiters.get(token);
        if (!w) return;
        this.waiters.delete(token);
        const msg = this.findMessageByWaitToken(token);
        if (msg && (msg.status === 'pending' || msg.status === 'delivered')) {
          this.deps.ctx.companyStore.setInboxStatus(msg.id, 'expired', {
            answer: '(no response from target before timeout)',
          });
          this.deps.publisher.publish('inbox_message_expired', { messageId: msg.id });
        }
        reject(new Error(`Inbox wait timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.waiters.set(token, { resolve, reject, timer });
    });
  }

  // ─── Respond ──────────────────────────────────────────────────

  respond(messageId: number, answer: string): boolean {
    const msg = this.deps.ctx.companyStore.getInboxMessage(messageId);
    if (!msg) return false;
    if (msg.status !== 'pending' && msg.status !== 'delivered') return false;
    const updated = this.deps.ctx.companyStore.answerInboxMessage(messageId, answer);
    if (!updated) return false;

    this.deps.publisher.publish('inbox_message_answered', {
      messageId: updated.id,
      from: { agentRunId: updated.from_agent_run_id, role: updated.from_role },
      to: { agentRunId: updated.to_agent_run_id, role: updated.to_role },
    });

    // Wake any wait_token-based listener — the constructor's signal
    // handler does the actual resolve. We piggyback `attention` so
    // the wakeup respects the same event channel as plan/question.
    if (updated.wait_token) {
      this.deps.attention.signal({
        kind: 'inbox_answered',
        agentRunId: updated.from_agent_run_id,
        role: updated.wait_token,
      });
    }
    return true;
  }

  cancel(messageId: number, reason: string): boolean {
    const msg = this.deps.ctx.companyStore.getInboxMessage(messageId);
    if (!msg) return false;
    if (msg.status === 'answered' || msg.status === 'cancelled' || msg.status === 'expired') return false;
    this.deps.ctx.companyStore.setInboxStatus(messageId, 'cancelled', { answer: `(cancelled: ${reason})` });
    this.deps.publisher.publish('inbox_message_cancelled', { messageId, reason });
    if (msg.wait_token) {
      // Unblock the sender — propagate the cancellation as a normal
      // resolve with the reason so its `respond_to_inbox` handler
      // can surface it.
      const w = this.waiters.get(msg.wait_token);
      if (w) {
        clearTimeout(w.timer);
        this.waiters.delete(msg.wait_token);
        w.resolve(`(cancelled: ${reason})`);
      }
    }
    return true;
  }

  // ─── List / detect ────────────────────────────────────────────

  list(opts: {
    status?: InboxStatus | InboxStatus[];
    toRole?: string;
    toAgentRunId?: number;
    fromAgentRunId?: number;
    limit?: number;
  }): AgentInboxMessage[] {
    return this.deps.ctx.companyStore.listInboxMessages({
      companySessionId: this.deps.ctx.companySessionId,
      ...opts,
    });
  }

  /**
   * BFS over pending/delivered messages. Returns true when sending
   * `from → to` would close a chain ending back at `from`. We resolve
   * `to_role`-only messages by looking at the role's running agent
   * runs; this is conservative — if there's any candidate run that
   * already holds a message back at `from`, we treat it as a cycle.
   */
  detectCycle(args: {
    fromAgentRunId: number;
    toRole?: string;
    toAgentRunId?: number;
  }): boolean {
    const seeds = this.resolveCycleSeeds(args.toRole, args.toAgentRunId);
    if (seeds.length === 0) return false;

    const visited = new Set<number>();
    const queue = [...seeds];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current === args.fromAgentRunId) return true;

      // Find every open message where `current` is the sender — those
      // run-ids it's waiting on become the next BFS frontier.
      const outgoing = this.deps.ctx.companyStore.listInboxMessages({
        companySessionId: this.deps.ctx.companySessionId,
        status: ['pending', 'delivered'],
        fromAgentRunId: current,
      });
      for (const m of outgoing) {
        const targets = this.resolveCycleSeeds(m.to_role ?? undefined, m.to_agent_run_id ?? undefined);
        for (const t of targets) if (!visited.has(t)) queue.push(t);
      }
    }
    return false;
  }

  // ─── Drain ─────────────────────────────────────────────────────

  /**
   * Called by `SubordinateLifecycle` when an agent transitions to a
   * non-busy status. Picks the next pending message for the agent
   * and reactivates the runner with it. No-op when the agent is gone
   * or there is nothing to drain.
   */
  async drainOnIdle(agentRunId: number, role: string): Promise<void> {
    const previous = this.drainMutexes.get(agentRunId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((res) => { release = res; });
    this.drainMutexes.set(agentRunId, previous.then(() => next));
    try {
      await previous;
      const message = this.deps.ctx.companyStore.claimNextInboxForAgent({
        companySessionId: this.deps.ctx.companySessionId,
        agentRunId,
        role,
      });
      if (!message) return;

      const prompt = formatInboxPrompt(message);
      const ok = await this.deps.subordinates.reactivate(agentRunId, prompt);

      this.deps.publisher.publish('inbox_message_delivered', {
        messageId: message.id,
        deliveredTo: { agentRunId, role },
        success: ok,
      });

      if (!ok) {
        // Couldn't wake the agent — flip the row back to pending so
        // the next idle transition tries again. This keeps the
        // `delivered_at` audit timestamp on the row but reopens the
        // claim window.
        this.deps.ctx.companyStore.setInboxStatus(message.id, 'pending');
      }
    } finally {
      release();
      // Only forget the chain pointer if no later send() chained on top.
      if (this.drainMutexes.get(agentRunId) === previous.then(() => next)) {
        this.drainMutexes.delete(agentRunId);
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private resolveTargetRunId(msg: AgentInboxMessage): number | null {
    if (msg.to_agent_run_id != null) return msg.to_agent_run_id;
    if (!msg.to_role) return null;
    const candidates = this.deps.ctx.companyStore.listAgentRuns(this.deps.ctx.companySessionId)
      .filter((r) => r.role === msg.to_role && r.role !== 'master');
    if (candidates.length === 0) return null;
    // Prefer the run with the smallest pending backlog so messages
    // load-balance across multiple agents playing the same role.
    let best: { id: number; backlog: number } | null = null;
    for (const r of candidates) {
      const backlog = this.deps.ctx.companyStore.listInboxMessages({
        companySessionId: this.deps.ctx.companySessionId,
        toAgentRunId: r.id,
        status: ['pending', 'delivered'],
      }).length;
      if (!best || backlog < best.backlog) best = { id: r.id, backlog };
    }
    return best?.id ?? null;
  }

  /** Resolve potential target run ids for cycle detection. */
  private resolveCycleSeeds(toRole?: string, toAgentRunId?: number): number[] {
    if (typeof toAgentRunId === 'number') return [toAgentRunId];
    if (!toRole) return [];
    return this.deps.ctx.companyStore.listAgentRuns(this.deps.ctx.companySessionId)
      .filter((r) => r.role === toRole && r.role !== 'master')
      .map((r) => r.id);
  }

  private findMessageByWaitToken(token: string): AgentInboxMessage | null {
    // Token is unique across pending/answered rows of the session — a
    // narrow scan is fine here.
    const rows = this.deps.ctx.companyStore.listInboxMessages({
      companySessionId: this.deps.ctx.companySessionId,
      limit: 200,
    });
    return rows.find((m) => m.wait_token === token) ?? null;
  }
}

// ─── Pure helpers ─────────────────────────────────────────────

/**
 * Statuses that count as "ready to receive a new prompt". Active
 * runners stay busy; everything terminal-but-resumable can be
 * reactivated immediately.
 */
function isIdleStatus(status: string): boolean {
  return (
    status === 'waiting' ||
    status === 'completed' ||
    status === 'idle' ||
    status === 'aborted' ||
    status === 'error' ||
    status === 'interrupted'
  );
}

function makeToken(): string {
  return `inbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Format the prompt the receiver sees when an inbox message is
 * delivered. Includes the originator role and the message id so the
 * receiver can call `respond_to_inbox` correctly.
 *
 * Exported for tests + frontend preview.
 */
export function formatInboxPrompt(msg: AgentInboxMessage): string {
  return (
    `[INBOX message_id=${msg.id} from=@${msg.from_role}] ${msg.body}\n\n` +
    `Respond using respond_to_inbox(message_id=${msg.id}, answer=...). ` +
    `If you need to delegate first, do so before responding.`
  );
}
