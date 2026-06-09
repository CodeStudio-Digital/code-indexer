/**
 * RuntimeReconciler — periodic sweep that keeps `agent_runs.status` in
 * the DB consistent with the runtime state of the orchestrator.
 *
 * Boot recovery already covers the cold-start path (`server.ts` calls
 * `companyStore.recoverStaleAgentRuns` and `MasterInboxRouter.reviveIfPending`),
 * but doesn't help DURING a live session. If something kills the master
 * runner without flipping the DB (worker thread crash, uncaught throw
 * inside a tool, OS-level OOM), the row stays at `status='running'`
 * forever and the dashboard renders a status that doesn't match reality.
 *
 * Two responsibilities, one timer:
 *   1. Force `status='idle'` on agent_runs whose runtime says they're
 *      dead (master `_handle == null || _ended === true`, or subordinate
 *      missing from `subordinates` map).
 *   2. (Item 3 — Heartbeat Master) If the master is dead AND there are
 *      pending master inbox messages, kick `masterInbox.tryDeliverNow()`
 *      so the message router gets another shot at resurrecting the
 *      master. Covers the case where a transient failure in the original
 *      delivery left messages stranded.
 *
 * Timer uses `.unref()` so it never holds Node alive past graceful exit.
 * Cadence is 45s by default; override via `MCP_COMPANY_RECONCILE_MS`.
 */
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { MasterLifecycle } from '@mcp/company/services/MasterLifecycle.js';
import type { SubordinateLifecycle } from '@mcp/company/services/SubordinateLifecycle.js';
import type { MasterInboxRouter } from '@mcp/company/services/MasterInboxRouter.js';
import { MASTER_INBOX_SENTINEL } from '@mcp/company/services/MasterInboxRouter.js';
import type { HumanInTheLoop } from '@mcp/company/services/HumanInTheLoop.js';
import type { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';

const DEFAULT_INTERVAL_MS = 45_000;

function readInterval(): number {
  const raw = process.env.MCP_COMPANY_RECONCILE_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 1_000 ? n : DEFAULT_INTERVAL_MS;
}

// ── Master re-nudge (Item 4) — bridge the gap between a lost wake-up and the
//    30-min MCP_SUBORDINATE_MASTER_WAIT_MS hard fallback, WITHOUT the LLM. ──

/** Re-nudge cadence — its own timer, independent of the 45s reconcile tick,
 *  so a 30s stall is detected with ≤15s latency instead of up to 45s. */
const NUDGE_TICK_MS = 15_000;
const DEFAULT_NUDGE_MS = 30_000;
const NUDGE_LRU_MAX = 1_000;
/** Per-key cooldowns so we re-nudge a still-stuck item again later, but never
 *  every tick. Resurrect is costly → longer cooldown. */
const COOLDOWN_DECISION_MS = 30_000;
const COOLDOWN_RESURRECT_MS = 90_000;

/** 0 = disabled. Non-numeric / negative → default; 1..999 → floored at 1s to
 *  avoid a hot re-nudge loop. */
function readNudgeMs(): number {
  const raw = process.env.MCP_COMPANY_MASTER_NUDGE_MS;
  if (raw === undefined || raw === '') return DEFAULT_NUDGE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_NUDGE_MS;
  if (n === 0) return 0;
  return n >= 1_000 ? n : 1_000;
}

/**
 * Parse a SQLite timestamp to epoch ms. `datetime('now')` yields
 * "YYYY-MM-DD HH:MM:SS" in UTC with NO zone marker — `Date.parse` would read
 * that as LOCAL time and skew the age by the host's UTC offset (hours).
 * Normalize to explicit UTC; ISO strings that already carry a zone pass through.
 */
function parseSqliteUtc(s: string | null | undefined): number {
  if (!s) return NaN;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) return Date.parse(s);
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

function decisionKindOf(status: string): 'plan' | 'question' | 'tasks' | null {
  if (status === 'waiting_plan') return 'plan';
  if (status === 'waiting_question') return 'question';
  if (status === 'waiting_tasks') return 'tasks';
  return null;
}

export interface RuntimeReconcilerDeps {
  ctx: SessionContext;
  master: MasterLifecycle;
  subordinates: SubordinateLifecycle;
  masterInbox: MasterInboxRouter;
  publisher: IMetaBusPublisher;
  /** Source of truth for which subordinates are blocked awaiting a master
   *  decision (plan/question/tasks) — used by the re-nudge sweep. */
  humanInLoop: HumanInTheLoop;
  /** Attention bus used to re-wake a master parked in `wait_for_subordinates`. */
  attention: MasterAttention;
  /** Override for tests. Defaults to `Date.now()`. */
  now?: () => number;
}

export class RuntimeReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Second timer dedicated to the re-nudge sweep (NUDGE_TICK_MS). */
  private nudgeTimer: ReturnType<typeof setInterval> | null = null;
  private nudging = false;
  /** Per-key last-nudge wall-clock for cooldown dedup. Bounded LRU. */
  private readonly lastNudgeAt = new Map<string, number>();

  constructor(private readonly deps: RuntimeReconcilerDeps) {}

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = readInterval();
    this.timer = setInterval(() => {
      // Skip overlapping ticks — listAgentRuns + companyStore reads are
      // small but tool-call deliveries inside heartbeat can take a beat.
      if (this.running) return;
      void this.tick();
    }, intervalMs);
    // Don't hold Node alive on shutdown.
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }

    // Re-nudge sweep on its own faster cadence — armed only when enabled
    // (nudgeMs !== 0), so a disabled knob costs zero timers.
    if (readNudgeMs() !== 0) {
      this.nudgeTimer = setInterval(() => {
        if (this.nudging) return;
        this.nudging = true;
        void this.nudgeStalledMasterDecisions().finally(() => { this.nudging = false; });
      }, NUDGE_TICK_MS);
      if (typeof (this.nudgeTimer as { unref?: () => void }).unref === 'function') {
        (this.nudgeTimer as { unref: () => void }).unref();
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.nudgeTimer) {
      clearInterval(this.nudgeTimer);
      this.nudgeTimer = null;
    }
  }

  /** Exposed for tests — runs one reconcile pass synchronously. */
  async tick(): Promise<void> {
    this.running = true;
    try {
      await this.reconcileMaster();
      await this.reconcileSubordinates();
      await this.heartbeatMasterInbox();
    } catch (e) {
      console.warn(
        `[company s=${this.deps.ctx.companySessionId}] reconciler tick failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }
  }

  // ── Master ────────────────────────────────────────────────────────

  private async reconcileMaster(): Promise<void> {
    const sessionId = this.deps.ctx.companySessionId;
    // Find any agent_run row for the master with a "live" status that
    // doesn't match the runtime. We use listAgentRuns + filter rather
    // than a custom query because the row count per session is small.
    const runs = this.deps.ctx.companyStore.listAgentRuns(sessionId);
    const masterRow = runs.find((r) => r.role === 'master');
    if (!masterRow) return;
    const dbSaysRunning =
      masterRow.status === 'running' ||
      masterRow.status === 'waiting_plan' ||
      masterRow.status === 'waiting_question' ||
      masterRow.status === 'waiting_tasks';
    if (!dbSaysRunning) return;
    if (this.deps.master.isAlive) return;
    // Runtime says dead, DB says running — reconcile.
    this.deps.ctx.companyStore.updateAgentRunStatus(masterRow.id, 'idle', 'reconciled');
    this.deps.publisher.publish('agent_status', {
      agentRunId: masterRow.id,
      role: 'master',
      status: 'idle',
      message: 'reconciled',
    });
    console.log(
      `[company s=${sessionId}] reconciler: master ${masterRow.id} was '${masterRow.status}' but runtime dead — flipped to idle`,
    );
  }

  // ── Subordinates ──────────────────────────────────────────────────

  private async reconcileSubordinates(): Promise<void> {
    const sessionId = this.deps.ctx.companySessionId;
    const runs = this.deps.ctx.companyStore.listAgentRuns(sessionId);
    for (const r of runs) {
      if (r.role === 'master') continue;
      const dbSaysRunning =
        r.status === 'running' ||
        r.status === 'waiting_plan' ||
        r.status === 'waiting_question' ||
        r.status === 'waiting_tasks';
      if (!dbSaysRunning) continue;
      // Subordinate is "live" if SubordinateLifecycle still tracks it.
      // `statusOf` returns null when the agent isn't in the in-memory map.
      const tracked = this.deps.subordinates.statusOf(r.id);
      if (tracked) continue;
      // DB says running, but the orchestrator no longer has this run.
      // Reconcile to idle.
      this.deps.ctx.companyStore.updateAgentRunStatus(r.id, 'idle', 'reconciled');
      this.deps.publisher.publish('agent_status', {
        agentRunId: r.id,
        role: r.role,
        status: 'idle',
        message: 'reconciled',
      });
      console.log(
        `[company s=${sessionId}] reconciler: subordinate ${r.id} (${r.role}) was '${r.status}' but runtime gone — flipped to idle`,
      );
    }
  }

  // ── Master inbox heartbeat (Item 3) ───────────────────────────────

  /**
   * If the master is dead AND there are pending inbox messages for it,
   * fire another delivery attempt. The router's `tryDeliverNow` is
   * idempotent + uses an atomic claim, so a redundant call when the
   * router is already healthy is a no-op.
   *
   * This closes the gap where the original delivery threw silently
   * (mutex chain broken, transient store error) and the messages just
   * sat at status=pending until the next user message kicked the
   * router via a separate path. With this heartbeat, the worst-case
   * staleness is one reconciler interval (~45s default).
   */
  private async heartbeatMasterInbox(): Promise<void> {
    if (this.deps.master.isAlive) return;
    const pending = this.deps.ctx.companyStore.listInboxMessages({
      companySessionId: this.deps.ctx.companySessionId,
      toRole: MASTER_INBOX_SENTINEL,
      status: 'pending',
      limit: 1,
    });
    if (pending.length === 0) return;
    console.log(
      `[company s=${this.deps.ctx.companySessionId}] reconciler heartbeat: master dead with pending inbox — calling tryDeliverNow`,
    );
    await this.deps.masterInbox.tryDeliverNow();
  }

  // ── Master re-nudge (Item 4) ──────────────────────────────────────

  /**
   * Re-wake a stalled master WITHOUT calling the LLM. Runs on its own 15s
   * timer (independent of the 45s reconcile tick). Three cases:
   *   (a) master ALIVE + a subordinate's plan/question/tasks pending longer
   *       than the threshold → re-emit the attention signal. The message is
   *       already in pendingUserMessages, so re-notifying would DUPLICATE it;
   *       we only re-fire the wake signal that `notify` emits.
   *   (b) master ALIVE + a master-bound inbox message stalled → re-run the
   *       idempotent `tryDeliverNow`.
   *   (c) master DEAD + a decision pending but no inbox row to revive it →
   *       `notify` to resurrect so it can read the board and respond.
   *       (Dead + pending inbox is already covered by `heartbeatMasterInbox`.)
   *
   * Dedup: per-key cooldown (`recentlyNudged`) re-nudges a still-stuck item
   * later but never every tick. A decision resolved in the meantime is skipped
   * because the in-memory `hasPending*` cross-check returns false.
   */
  private async nudgeStalledMasterDecisions(): Promise<void> {
    const nudgeMs = readNudgeMs();
    if (nudgeMs === 0) return;
    const sessionId = this.deps.ctx.companySessionId;
    const now = this.nowMs();

    const stalled = this.deps.ctx.companyStore
      .listAgentRuns(sessionId)
      .filter((r) => {
        if (r.role === 'master') return false;
        const kind = decisionKindOf(r.status);
        if (!kind || !this.decisionStillPending(r.id, kind)) return false;
        const ageMs = now - parseSqliteUtc(r.updated_at);
        return Number.isFinite(ageMs) && ageMs >= nudgeMs;
      });

    if (this.deps.master.isAlive) {
      for (const r of stalled) {
        const kind = decisionKindOf(r.status)!;
        const key = `a:${r.id}:${kind}`;
        if (this.recentlyNudged(key, now)) continue;
        this.recordNudge(key, now);
        // NO LLM, NO re-push: the original notification is still buffered in
        // pendingUserMessages. Re-emit the wake signal (and defensively break a
        // waitForUserInput, mirroring HumanInTheLoop's original post).
        this.deps.master.handle?.runner.interruptWait({ kind, agentRunId: r.id, role: r.role });
        this.deps.attention.signal({ kind, agentRunId: r.id, role: r.role });
        this.publishNudge({ case: 'decision', agentRunId: r.id, role: r.role, kind, ageMs: now - parseSqliteUtc(r.updated_at) });
        console.log(`[company s=${sessionId}] master nudge (decision): re-woke for run=${r.id} kind=${kind}`);
      }
      await this.nudgeStalledInbox(sessionId, now, nudgeMs);
      return;
    }

    // Master dead: revive for a pending decision the inbox heartbeat won't see.
    if (stalled.length > 0 && !this.recentlyNudged('c:resurrect', now)) {
      this.recordNudge('c:resurrect', now);
      this.deps.master.notify(
        '[SYSTEM] A subordinate is blocked awaiting your decision and your run had ended. ' +
        'Resuming so you can review the pending plan/question/tasks on the board and respond.',
      );
      this.publishNudge({ case: 'resurrect', reason: 'decision_pending' });
      console.log(`[company s=${sessionId}] master nudge (resurrect): ${stalled.length} pending decision(s), master dead`);
    }
  }

  private decisionStillPending(id: number, kind: 'plan' | 'question' | 'tasks'): boolean {
    if (kind === 'plan') return this.deps.humanInLoop.hasPendingPlan(id);
    if (kind === 'question') return this.deps.humanInLoop.hasPendingQuestion(id);
    return this.deps.humanInLoop.hasPendingTasks(id);
  }

  private async nudgeStalledInbox(sessionId: number, now: number, nudgeMs: number): Promise<void> {
    const pending = this.deps.ctx.companyStore.listInboxMessages({
      companySessionId: sessionId,
      toRole: MASTER_INBOX_SENTINEL,
      status: 'pending',
    });
    const oldest = pending.find((m) => {
      const created = parseSqliteUtc(m.created_at);
      return Number.isFinite(created) && now - created >= nudgeMs;
    });
    if (!oldest || this.recentlyNudged(`b:${oldest.id}`, now)) return;
    this.recordNudge(`b:${oldest.id}`, now);
    await this.deps.masterInbox.tryDeliverNow();
    this.publishNudge({ case: 'inbox', messageId: oldest.id, ageMs: now - parseSqliteUtc(oldest.created_at) });
    console.log(`[company s=${sessionId}] master nudge (inbox): re-delivered, oldest msg=${oldest.id}`);
  }

  private recentlyNudged(key: string, now: number): boolean {
    const at = this.lastNudgeAt.get(key);
    if (at === undefined) return false;
    const cooldown = key.startsWith('c:') ? COOLDOWN_RESURRECT_MS : COOLDOWN_DECISION_MS;
    return now - at < cooldown;
  }

  private recordNudge(key: string, now: number): void {
    if (this.lastNudgeAt.size >= NUDGE_LRU_MAX) {
      const first = this.lastNudgeAt.keys().next().value;
      if (first !== undefined) this.lastNudgeAt.delete(first);
    }
    this.lastNudgeAt.set(key, now);
  }

  private publishNudge(payload: {
    case: 'decision' | 'inbox' | 'resurrect';
    agentRunId?: number;
    role?: string;
    kind?: 'plan' | 'question' | 'tasks';
    messageId?: number;
    reason?: string;
    ageMs?: number;
  }): void {
    try {
      this.deps.publisher.publish('master_nudge', {
        companySessionId: this.deps.ctx.companySessionId,
        ...payload,
        at: this.nowMs(),
      });
    } catch { /* publish must never break the sweep */ }
  }
}
