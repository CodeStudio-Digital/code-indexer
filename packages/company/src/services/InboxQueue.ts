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
import type {
  MasterInboxRouter,
  MasterEnqueueResult,
} from '@mcp/company/services/MasterInboxRouter.js';
import { MASTER_INBOX_SENTINEL } from '@mcp/company/services/MasterInboxRouter.js';
import { raceWithTimeout, isMutexTimeout } from '@mcp/company/services/utils/promiseMutex.js';
import type { AgentInboxMessage, InboxKind, InboxStatus } from '@mcp/company/types.js';

/**
 * Default ceiling for `wait=true` senders waiting on an inbox answer.
 *
 * Bumped from 10min → 20min in Sprint 1 follow-up after observing
 * `EXPIRED` rows in production whose target was busy on a long task
 * (legitimate ~12-15 min runs). 20min covers ~95% of subordinate tasks
 * we've seen historically; longer waits are best handled by the C3
 * MessageRoutingPipeline (Sprint 3+) which can re-prioritise instead
 * of timing out.
 *
 * Override via env: `MCP_COMPANY_INBOX_WAIT_TIMEOUT_MS=<ms>`. Useful
 * during long-running multi-agent demos. Invalid/zero/negative values
 * fall back to the default.
 */
function resolveDefaultWaitTimeoutMs(): number {
  const fallback = 20 * 60 * 1000; // 20 minutes
  const raw = process.env.MCP_COMPANY_INBOX_WAIT_TIMEOUT_MS;
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const DEFAULT_WAIT_TIMEOUT_MS = resolveDefaultWaitTimeoutMs();

/**
 * Ceiling on how long a fresh `drainOnIdle` will wait for its agent's
 * previous drain to finish. Higher than the master ceiling (30s)
 * because a real subordinate reactivate can include a worker spawn +
 * model boot, which is legitimately slower than `master.notify`.
 */
const INBOX_DRAIN_MUTEX_TIMEOUT_MS = 60_000;

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
  /**
   * C6 — when true, `send()` runs `assessTargetHealth()` BEFORE creating
   * the inbox row and throws `HealthCheckError` if the target is
   * overloaded / failed / stale. Default false (legacy behavior:
   * messages always queue and rely on the timeout to fire EXPIRED).
   * Global default flipped by `MCP_COMPANY_INBOX_HEALTH_CHECK=1`.
   */
  failFastOnHealth?: boolean;
}

export interface SendResult {
  message: AgentInboxMessage;
  /** True when the queue could route the message immediately (target idle). */
  deliveredImmediately: boolean;
  /** Set when `wait=true`; pass to `waitForAnswer` to resolve when answered. */
  waitToken?: string;
}

/**
 * C6 — assessment shape returned by `InboxQueue.assessTargetHealth()`.
 */
export interface TargetHealthAssessment {
  healthy: boolean;
  /** Diagnostic reason when `healthy=false`. Stable enum for telemetry. */
  reason?: 'overloaded' | 'failed_status' | 'no_target_run' | 'stale_idle';
  /** Pending+delivered inbox count for the target. 0 when no target. */
  pendingCount: number;
  /** Status of the target's agent_run row (null if no run resolved). */
  targetStatus: string | null;
  /**
   * Other roles in the same company session that could potentially
   * accept this message — the sender can retry with one of these.
   * Populated when `healthy=false` and an alternative role exists.
   */
  alternativeRoles?: string[];
}

/**
 * Thrown by `send()` when `failFastOnHealth=true` and the target's
 * health assessment says no. Carries the assessment for the caller to
 * decide what to do — retry with `assessment.alternativeRoles[0]`,
 * cancel, or escalate to the master.
 */
export class TargetHealthCheckError extends Error {
  constructor(public readonly assessment: TargetHealthAssessment) {
    super(
      `inbox_target_unhealthy:${assessment.reason ?? 'unknown'} ` +
        `(pending=${assessment.pendingCount}, status=${assessment.targetStatus ?? 'null'})`,
    );
    this.name = 'TargetHealthCheckError';
  }
}

/**
 * C6 — tunables. Read from env on every send() to keep tests + admin
 * tuning predictable. Per-target cap on `pending+delivered` messages
 * before send() refuses; threshold for "stale idle" target detection.
 */
function resolveMaxPendingPerTarget(): number {
  const raw = process.env.MCP_COMPANY_INBOX_MAX_PENDING;
  if (!raw) return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}
function resolveStaleIdleMs(): number {
  const raw = process.env.MCP_COMPANY_INBOX_STALE_IDLE_MS;
  if (!raw) return 5 * 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
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
  /**
   * Late-bound MasterInboxRouter. Set by the orchestrator after both
   * services exist (router needs MasterLifecycle, which is built before
   * InboxQueue). Mensagens com `to_role='__master__'` são redirecionadas
   * para o router; sem ele, ficariam pending para sempre porque o
   * master não é um `company_agent_run` consumindo drain.
   */
  private masterRouter: MasterInboxRouter | null = null;

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

  /**
   * Bind the {@link MasterInboxRouter} that handles `to_role='__master__'`
   * messages. Called once by the orchestrator after both services exist.
   * Pass `null` to detach (test cleanup).
   */
  setMasterRouter(router: MasterInboxRouter | null): void {
    this.masterRouter = router;
  }

  // ─── Send (async with routing pipeline) ───────────────────────
  //
  // C7 — async variant that runs the InboxRoutingPipeline BEFORE
  // delegating to the legacy sync `send()`. The pipeline chooses the
  // best target (smallest backlog, healthy, etc.) and provides a
  // failover list — caller can retry with `args.toAgentRunId` set to
  // a failover id when the first send results in EXPIRED.
  //
  // The legacy `send()` stays as-is for backward compat. Callers that
  // want the smart routing call `sendAsync()` explicitly.
  //
  // The pipeline is passed in (not stored on the queue) to keep the
  // existing constructor signature unchanged. Hosts construct the
  // pipeline once via `createInboxRoutingPipeline()` and pass it on
  // each call.

  /**
   * Smart async send: route via `InboxRoutingPipeline` to pick the
   * healthiest target, then delegate to the legacy `send()`. Returns
   * the SendResult enriched with the routing decision so the caller
   * can inspect `failoverRunIds` if they want to retry on failure.
   *
   * When the pipeline can't find ANY healthy target, throws
   * `TargetHealthCheckError` regardless of `failFastOnHealth` —
   * there's literally no one to send to.
   */
  async sendAsync(
    args: SendArgs,
    routingPipeline: import('@mcp/candidate-pipeline').CandidatePipeline<
      import('./inbox-routing-pipeline.js').InboxRoutingQuery,
      import('./inbox-routing-pipeline.js').AgentRunCandidate
    >,
  ): Promise<SendResult & { routing: import('./inbox-routing-pipeline.js').RoutingDecision }> {
    // Master-bound short-circuit — same as legacy send().
    if (args.toRole === MASTER_INBOX_SENTINEL) {
      const sync = this.send(args);
      return { ...sync, routing: { targetRunId: null, failoverRunIds: [], rejected: [] } };
    }

    // Snapshot the current state ONCE for the pipeline. Pipeline
    // stages don't re-query — keeps decisions deterministic per call.
    const agentRuns = this.deps.ctx.companyStore.listAgentRuns(this.deps.ctx.companySessionId);
    const pendingByRunId = new Map<number, ReadonlyArray<AgentInboxMessage>>();
    for (const run of agentRuns) {
      const pending = this.deps.ctx.companyStore.listInboxMessages({
        companySessionId: this.deps.ctx.companySessionId,
        toAgentRunId: run.id,
        status: ['pending', 'delivered'],
      });
      pendingByRunId.set(run.id, pending);
    }

    const { routeInbox } = await import('./inbox-routing-pipeline.js');
    const decision = await routeInbox(routingPipeline, {
      queryId: `inbox-send-${Date.now()}`,
      companySessionId: this.deps.ctx.companySessionId,
      toRole: args.toRole,
      toAgentRunId: args.toAgentRunId,
      agentRuns,
      pendingByRunId,
    });

    if (decision.targetRunId == null) {
      // Pipeline rejected every candidate — throw with the assessment
      // so the caller knows WHY (overloaded vs failed_status).
      const reason = decision.rejected[0]?.reason ?? 'no_target_run';
      throw new TargetHealthCheckError({
        healthy: false,
        reason: reason === 'overloaded' ? 'overloaded' : reason === 'failed_status' ? 'failed_status' : 'no_target_run',
        pendingCount: 0,
        targetStatus: null,
        alternativeRoles: this.findAlternativeRoles(args.toRole),
      });
    }

    // Send via legacy path with the routing decision baked in as
    // toAgentRunId. This bypasses resolveTargetRunId() — caller's
    // routing wins.
    const sync = this.send({
      ...args,
      toAgentRunId: decision.targetRunId,
    });
    return { ...sync, routing: decision };
  }

  // ─── Send ─────────────────────────────────────────────────────

  send(args: SendArgs): SendResult {
    if (!args.toRole && typeof args.toAgentRunId !== 'number') {
      throw new Error('send_to_agent: pass either target_role or target_agent_run_id.');
    }

    // Short-circuit: messages addressed to the master sentinel bypass
    // cycle detection (master is excluded from the BFS seeds anyway) and
    // peer drain logic (master is not a `company_agent_run`). Routed to
    // MasterInboxRouter which coalesces multiple inbound notifications
    // into a single resurrect/notify call.
    if (args.toRole === MASTER_INBOX_SENTINEL) {
      if (!this.masterRouter) {
        throw new Error(
          'InboxQueue: master sentinel target requires a bound MasterInboxRouter. ' +
            'Wire it via setMasterRouter() during orchestrator construction.',
        );
      }
      const result: MasterEnqueueResult = this.masterRouter.enqueueForMaster({
        fromAgentRunId: args.fromAgentRunId,
        fromRole: args.fromRole,
        kind: args.kind,
        body: args.body,
        waitToken: args.wait ? makeToken() : null,
      });
      // When the sender asked to wait, register a waiter so
      // `waitForAnswer(token)` resolves once the master answers via
      // `respond_to_inbox`. Reuses the same wait_token path as peers.
      return {
        message: result.message,
        deliveredImmediately: result.deliveredImmediately,
        waitToken: result.message.wait_token ?? undefined,
      };
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

    // C6 — Sprint 3.5. Pre-check target health BEFORE creating an inbox
    // row that would otherwise sit pending and time out. Opt-in:
    //   - SendArgs.failFastOnHealth=true (per-call)
    //   - MCP_COMPANY_INBOX_HEALTH_CHECK=1 (global default)
    // Legacy callers without either flag keep the original behavior
    // (always queue, rely on timeout to fire EXPIRED).
    const failFast =
      args.failFastOnHealth === true ||
      process.env.MCP_COMPANY_INBOX_HEALTH_CHECK === '1';
    if (failFast) {
      const assessment = this.assessTargetHealth({
        toRole: args.toRole,
        toAgentRunId: args.toAgentRunId,
      });
      if (!assessment.healthy) {
        throw new TargetHealthCheckError(assessment);
      }
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

    // Phase B "master observer": when the template opts into
    // `master_broadcast_subscribe`, every peer-to-peer message also
    // generates a fire-and-forget `notify` copy addressed to the master
    // so the orchestrator stays aware of inter-subordinate traffic
    // without gating it. Read from the live session config so toggling
    // the flag at runtime takes effect on the next send. We skip the
    // copy when the master router is unwired (test fixtures) and when
    // the original message was already master-bound (handled above).
    if (this.masterRouter && this.shouldBroadcastToMaster()) {
      try {
        this.masterRouter.enqueueForMaster({
          fromAgentRunId: args.fromAgentRunId,
          fromRole: args.fromRole,
          kind: 'notify',
          body: formatBroadcastBody(args, message.id),
          waitToken: null,
        });
      } catch (e) {
        // Broadcast failure must not break the primary delivery path.
        console.warn(
          `[inbox] master broadcast copy failed for message ${message.id}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

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
   * Check the session's `config_json` for the `master_broadcast_subscribe`
   * flag. Defensive parsing — bad JSON / missing field → `false`. Cheap
   * (small string) but called once per peer-to-peer send; if traffic
   * volume becomes a hot spot, swap to a cached read invalidated by
   * `session.config_updated`.
   */
  private shouldBroadcastToMaster(): boolean {
    try {
      const row = this.deps.ctx.companyStore.getCompanySession(this.deps.ctx.companySessionId);
      if (!row?.config_json) return false;
      const cfg = JSON.parse(row.config_json) as { master_broadcast_subscribe?: unknown };
      return cfg.master_broadcast_subscribe === true;
    } catch {
      return false;
    }
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

  // ─── C9 — Async-friendly accessors (Sprint 3.5 infra-only) ────
  //
  // These let callers that DON'T use `wait=true` still observe message
  // status without blocking. Two patterns:
  //   1. Poll: `getMessageStatus(id)` returns the current row.
  //   2. Subscribe: `onMessageAnswered(id, cb)` fires when answer
  //      arrives, with `unsubscribe` for cleanup.
  //
  // The full async-by-default refactor (sender doesn't block; turn loop
  // is reactivated when answer arrives) is deferred — needs tool-level
  // contract changes. These accessors are the infra hook for that work.

  /**
   * Snapshot the current state of a message — status + answer + any
   * already-populated timestamps. Returns null when the id doesn't
   * exist. Pure read, no waiting.
   */
  getMessageStatus(messageId: number): {
    status: InboxStatus;
    answer: string | null;
    deliveredAt: string | null;
    answeredAt: string | null;
  } | null {
    const msg = this.deps.ctx.companyStore.getInboxMessage(messageId);
    if (!msg) return null;
    return {
      status: msg.status,
      answer: msg.answer ?? null,
      deliveredAt: msg.delivered_at ?? null,
      answeredAt: msg.answered_at ?? null,
    };
  }

  /**
   * Register a callback that fires exactly once when `messageId` is
   * answered (or expires). Returns an `unsubscribe()` function — callers
   * MUST call it on cleanup to avoid the listener leaking. The callback
   * runs SYNC inside the publisher's event delivery; keep it fast.
   *
   * Designed for the future async-by-default sender refactor where the
   * tool returns immediately with a `messageToken`, and the turn loop
   * later reactivates the runner via this subscription.
   */
  onMessageAnswered(
    messageId: number,
    callback: (event: {
      messageId: number;
      status: 'answered' | 'expired' | 'cancelled';
      answer: string | null;
    }) => void,
  ): () => void {
    const unsubscribers: Array<() => void> = [];
    let fired = false;
    const fire = (status: 'answered' | 'expired' | 'cancelled'): void => {
      if (fired) return;
      fired = true;
      const snap = this.getMessageStatus(messageId);
      try {
        callback({
          messageId,
          status,
          answer: snap?.answer ?? null,
        });
      } catch (e) {
        console.warn(
          `[inbox] onMessageAnswered callback threw: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      // One-shot — auto-cleanup all listeners.
      for (const u of unsubscribers) u();
    };

    // Subscribe via the existing attention bus for inbox_answered.
    // Note: attention.on signature doesn't return an unsubscribe in all
    // shapes — we degrade gracefully if it does. The fired guard
    // prevents double-fire either way.
    const handle = this.deps.attention.on((ev) => {
      if (ev.kind !== 'inbox_answered') return;
      // The constructor uses ev.role as a wait_token convention; for
      // the message-id subscription we need to look up the row.
      const msg = this.findMessageByWaitToken(ev.role);
      if (msg?.id === messageId && msg.status === 'answered') fire('answered');
    });
    if (typeof handle === 'function') {
      unsubscribers.push(handle);
    }

    // Poll-once: if the message is ALREADY in a terminal state when the
    // caller subscribes, fire immediately (next tick).
    const initial = this.getMessageStatus(messageId);
    if (initial) {
      if (initial.status === 'answered') setImmediate(() => fire('answered'));
      else if (initial.status === 'expired') setImmediate(() => fire('expired'));
      else if (initial.status === 'cancelled') setImmediate(() => fire('cancelled'));
    }

    return () => {
      fired = true; // prevent later fires
      for (const u of unsubscribers) u();
    };
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
    const chained = previous.then(() => next);
    this.drainMutexes.set(agentRunId, chained);
    try {
      // Bound the wait on the previous drain. If a peer's reactivate
      // hung (rare but possible — runner stuck in a long tool call),
      // we don't want THIS agent's drain wedged forever. 60s is twice
      // the master timeout because subordinate reactivate naturally
      // takes longer (spawn or warm-up of the worker).
      try {
        await raceWithTimeout(previous, INBOX_DRAIN_MUTEX_TIMEOUT_MS, `inbox_drain_${agentRunId}`);
      } catch (e) {
        if (isMutexTimeout(e)) {
          console.warn(
            `[company s=${this.deps.ctx.companySessionId}] inbox drainMutex timed out for agentRunId=${agentRunId} — resetting`,
          );
          // Drop the stuck previous from the chain. Subsequent drains
          // will only await `chained`, not the stuck step.
          this.drainMutexes.set(agentRunId, next);
        } else {
          throw e;
        }
      }
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
      if (this.drainMutexes.get(agentRunId) === chained) {
        this.drainMutexes.delete(agentRunId);
      }
    }
  }

  // ─── C6 — Target health assessment (Sprint 3.5) ──────────────

  /**
   * Inspect the target's agent_run row + pending inbox load and return
   * a structured health assessment. Pure read — no DB mutation. Can be
   * called directly by tools (e.g. `send_to_agent` could call this and
   * surface a hint to the agent before committing).
   *
   * Criteria (in order; first failure wins):
   *   - **no_target_run**: `toAgentRunId` doesn't exist, OR no agent_run
   *     matches `toRole` in the current session.
   *   - **failed_status**: target status ∈ {'failed', 'aborted'}.
   *   - **overloaded**: pending+delivered messages for target ≥
   *     `MCP_COMPANY_INBOX_MAX_PENDING` (default 3).
   *   - **stale_idle**: target is idle (waiting/paused) but its last
   *     activity (any inbox message handled, status change, etc.) is
   *     older than `MCP_COMPANY_INBOX_STALE_IDLE_MS` (default 5min).
   *     Best-effort heuristic — uses the agent_run's `updated_at`.
   *
   * Healthy → `{ healthy: true, pendingCount, targetStatus }`.
   */
  assessTargetHealth(args: {
    toRole?: string;
    toAgentRunId?: number;
  }): TargetHealthAssessment {
    // Resolve a target run (reuse logic similar to resolveTargetRunId).
    let targetRunId: number | null = null;
    let alternativeRunIds: number[] = [];
    if (typeof args.toAgentRunId === 'number') {
      targetRunId = args.toAgentRunId;
    } else if (args.toRole) {
      const runs = this.deps.ctx.companyStore
        .listAgentRuns(this.deps.ctx.companySessionId)
        .filter((r) => r.role === args.toRole && r.role !== 'master');
      if (runs.length > 0) {
        // Same load-balancing as resolveTargetRunId: smallest backlog.
        let best: { id: number; backlog: number } | null = null;
        for (const r of runs) {
          const backlog = this.deps.ctx.companyStore.listInboxMessages({
            companySessionId: this.deps.ctx.companySessionId,
            toAgentRunId: r.id,
            status: ['pending', 'delivered'],
          }).length;
          if (!best || backlog < best.backlog) best = { id: r.id, backlog };
        }
        targetRunId = best?.id ?? null;
        alternativeRunIds = runs.filter((r) => r.id !== targetRunId).map((r) => r.id);
      }
    }

    if (targetRunId == null) {
      return {
        healthy: false,
        reason: 'no_target_run',
        pendingCount: 0,
        targetStatus: null,
        alternativeRoles: this.findAlternativeRoles(args.toRole),
      };
    }

    const run = this.deps.ctx.companyStore.getAgentRun(targetRunId);
    if (!run) {
      // Explicit toAgentRunId passed but the run row doesn't exist —
      // treat as no_target_run rather than silently assuming healthy.
      return {
        healthy: false,
        reason: 'no_target_run',
        pendingCount: 0,
        targetStatus: null,
        alternativeRoles: this.findAlternativeRoles(args.toRole),
      };
    }
    const targetStatus = run.status;
    // 'error' / 'aborted' / 'interrupted' are terminal-ish — no point
    // queueing a message at a run that's not going to drain. 'completed'
    // is OK (the run sat idle waiting for next task).
    if (run.status === 'error' || run.status === 'aborted' || run.status === 'interrupted') {
      return {
        healthy: false,
        reason: 'failed_status',
        pendingCount: 0,
        targetStatus,
        alternativeRoles: alternativeRunIds.length === 0
          ? this.findAlternativeRoles(args.toRole)
          : undefined,
      };
    }

    const pending = this.deps.ctx.companyStore.listInboxMessages({
      companySessionId: this.deps.ctx.companySessionId,
      toAgentRunId: targetRunId,
      status: ['pending', 'delivered'],
    });
    const maxPending = resolveMaxPendingPerTarget();
    if (pending.length >= maxPending) {
      return {
        healthy: false,
        reason: 'overloaded',
        pendingCount: pending.length,
        targetStatus,
        alternativeRoles: alternativeRunIds.length === 0
          ? this.findAlternativeRoles(args.toRole)
          : undefined,
      };
    }

    // Stale-idle heuristic: target hasn't moved in N minutes despite
    // being idle. May be stuck. We use updated_at when present.
    if (
      run &&
      isIdleStatus(run.status) &&
      run.updated_at
    ) {
      const updatedMs = Date.parse(run.updated_at);
      if (Number.isFinite(updatedMs)) {
        const age = Date.now() - updatedMs;
        if (age > resolveStaleIdleMs()) {
          return {
            healthy: false,
            reason: 'stale_idle',
            pendingCount: pending.length,
            targetStatus,
            alternativeRoles: alternativeRunIds.length === 0
              ? this.findAlternativeRoles(args.toRole)
              : undefined,
          };
        }
      }
    }

    return { healthy: true, pendingCount: pending.length, targetStatus };
  }

  /**
   * Find roles that are NOT the target role and have at least one
   * healthy agent_run available in the session. Used to suggest
   * fallback targets when the requested role is unhealthy.
   */
  private findAlternativeRoles(excludeRole: string | undefined): string[] {
    const runs = this.deps.ctx.companyStore.listAgentRuns(this.deps.ctx.companySessionId);
    const seen = new Set<string>();
    const alternatives: string[] = [];
    for (const r of runs) {
      if (r.role === 'master') continue;
      if (excludeRole && r.role === excludeRole) continue;
      if (r.status === 'error' || r.status === 'aborted' || r.status === 'interrupted') continue;
      if (seen.has(r.role)) continue;
      seen.add(r.role);
      alternatives.push(r.role);
    }
    return alternatives;
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

/**
 * Format the body of the broadcast copy delivered to the master when
 * `master_broadcast_subscribe` is on. The master sees this as a
 * fire-and-forget notify — no response required, no action implied —
 * carrying the original message id so the operator can cross-reference
 * the transcript panel.
 */
function formatBroadcastBody(
  args: { fromAgentRunId: number; fromRole: string; toRole?: string; toAgentRunId?: number; kind: InboxKind; body: string },
  originalMessageId: number,
): string {
  const target = args.toRole
    ? `@${args.toRole}`
    : args.toAgentRunId != null
      ? `run=${args.toAgentRunId}`
      : '@?';
  return (
    `[INBOX-OBSERVED message_id=${originalMessageId} ${args.fromRole}→${target} kind=${args.kind}]\n` +
    args.body
  );
}
