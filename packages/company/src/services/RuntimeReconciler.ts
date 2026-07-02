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
import type { KanbanService } from '@mcp/company/services/KanbanService.js';
import {
  isAutonomyActionAllowed,
  resolveAutonomy,
} from '@mcp/company/services/autonomy/autonomy-config.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
import { findOrphanedCards } from '@mcp/company/services/scheduler/dispatch-core.js';
import {
  countReadyTodoCards,
  evaluateNextCardNudge,
  readNextCardIdleMs,
} from '@mcp/company/services/scheduler/next-card-nudge.js';

const DEFAULT_INTERVAL_MS = 45_000;

/** Max auto-reestablish attempts per subordinate before the reconciler gives up
 *  and leaves it 'error' — stops a crash-loop from resuming forever. */
const REESTABLISH_MAX_ATTEMPTS = 3;

/** Auto re-establish a subordinate that was `running` when its runtime vanished
 *  (worker crash, uncaught throw, OOM) — flip the status so the UI stops showing
 *  "running", then resume it from its persisted coder session so it finishes the
 *  task. ON by default; `MCP_COMPANY_AUTO_REESTABLISH=0` falls back to the old
 *  flip-to-idle behaviour. */
function autoReestablishEnabled(): boolean {
  const raw = process.env.MCP_COMPANY_AUTO_REESTABLISH;
  if (raw == null || raw === '') return true;
  const v = raw.toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

/** Agent-run statuses that count as "still doing useful work". Anything else
 *  (idle/completed/error/aborted/interrupted/paused) is dead for the purpose
 *  of the orphaned-card sweep. */
const ACTIVE_RUN_STATUSES = new Set<string>([
  'running', 'working',
  'waiting', 'waiting_plan', 'waiting_question', 'waiting_tasks',
  'reviewing', 'blocked',
]);

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
/** Resurrect dedup window — shared with the AgentSupervisor (company-worker
 *  imports this so both watchers use the SAME window, no magic-number drift). */
export const COOLDOWN_RESURRECT_MS = 90_000;

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
  /** Kanban service — when present, the reconciler also frees cards stranded
   *  `in_progress` by a dead agent (Phase 2 self-repair). Optional so existing
   *  callers/tests that don't need it stay untouched. */
  kanban?: KanbanService;
  /**
   * C2 — per-session autonomy config, consulted at every orphan-reset sweep
   * so `freeze`/`scheduler=false` gate it LIVE. Optional: callers/tests
   * without it fall back to `resolveAutonomy(null, process.env)`.
   */
  autonomy?: Pick<AutonomyProvider, 'get'>;
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
  /** C3 — wall-clock of the last next-card nudge (its own long cooldown). */
  private lastNextCardNudgeAt = 0;
  /** Per-subordinate auto-reestablish attempt counter (crash-loop cap). Reset
   *  when the subordinate is observed healthy (tracked) again. */
  private readonly reestablishAttempts = new Map<number, number>();

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
      // Orphaned-card sweep runs AFTER reconcileSubordinates so it reads DB
      // statuses already flipped to idle for ghost runs — avoids a false reset
      // during a transient in-memory gap.
      this.reconcileOrphanedCards();
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
      const isRunning = r.status === 'running';
      const isWaiting =
        r.status === 'waiting_plan' ||
        r.status === 'waiting_question' ||
        r.status === 'waiting_tasks';
      if (!isRunning && !isWaiting) continue;
      // Subordinate is "live" if SubordinateLifecycle still tracks it.
      // `statusOf` returns null when the agent isn't in the in-memory map.
      const tracked = this.deps.subordinates.statusOf(r.id);
      if (tracked) {
        this.reestablishAttempts.delete(r.id); // healthy again — reset the cap
        continue;
      }

      // DB says active, but the orchestrator no longer has this run — it's a
      // GHOST (the "caiu mas fica mostrando rodando" bug). A subordinate that was
      // `running` (working) when its runner vanished should be RE-ESTABLISHED so
      // it finishes its task; a `waiting_*` one was merely parked on the master,
      // so just reconcile it to idle (the original behaviour).
      if (isRunning && autoReestablishEnabled()) {
        const attempts = (this.reestablishAttempts.get(r.id) ?? 0) + 1;
        if (attempts <= REESTABLISH_MAX_ATTEMPTS) {
          this.reestablishAttempts.set(r.id, attempts);
          // Flip off 'running' FIRST: the UI stops showing it running AND resume
          // is permitted (it rejects a 'running' row).
          this.deps.ctx.companyStore.updateAgentRunStatus(r.id, 'error', 'reconciler: runtime gone — re-establishing');
          this.deps.publisher.publish('agent_status', {
            agentRunId: r.id, role: r.role, status: 'error', message: 're-establishing',
          });
          const sys =
            `[SYSTEM] Your run stopped unexpectedly (the runtime went away) and was ` +
            `automatically re-established (attempt ${attempts}/${REESTABLISH_MAX_ATTEMPTS}). ` +
            `Continue your task from where you left off; if it was already done, post ` +
            `your deliverable and stop.`;
          try {
            await this.deps.subordinates.resume(r.id, sys);
            console.log(
              `[company s=${sessionId}] reconciler: subordinate ${r.id} (${r.role}) was 'running' but runtime gone — re-established (attempt ${attempts})`,
            );
          } catch (e) {
            console.warn(
              `[company s=${sessionId}] reconciler: re-establish of subordinate ${r.id} failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          continue;
        }
        // Crash-loop: exhausted attempts. Leave it 'error' (already flipped on a
        // prior attempt) so the UI shows it failed instead of resuming forever.
        console.warn(
          `[company s=${sessionId}] reconciler: subordinate ${r.id} (${r.role}) crashed ${attempts - 1}× — giving up auto-reestablish, leaving 'error'`,
        );
        continue;
      }

      // waiting_* ghost, or auto-reestablish disabled → reconcile to idle.
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

  // ── Orphaned cards (Phase 2 self-repair) ──────────────────────────

  /**
   * Free cards stranded `in_progress` by an agent that died mid-task. Without
   * this, a worker crash leaves the card showing "in progress" with nobody on
   * it forever — the dependency graph never unblocks downstream work. We
   * unassign the dead agent(s) and reset the card to `todo` so the scheduler
   * (or the master) can re-dispatch it.
   *
   * C2 — gated by the per-session autonomy config (action `orphanReset`,
   * which follows the scheduler default: ON). `freeze` or
   * `autonomy.scheduler=false` / env `MCP_COMPANY_SCHEDULER='0'` kill it
   * LIVE — the check runs at every sweep, not at boot. Only makes sense
   * paired with the dispatch loop that re-picks the freed card.
   * No-op when no kanban service was wired.
   */
  private reconcileOrphanedCards(): void {
    const cfg = this.deps.autonomy
      ? this.deps.autonomy.get()
      : resolveAutonomy(null, process.env);
    if (!isAutonomyActionAllowed(cfg, 'orphanReset')) return;
    const kanban = this.deps.kanban;
    if (!kanban) return;
    const sessionId = this.deps.ctx.companySessionId;

    let cardsFull;
    try {
      cardsFull = kanban.listCardsFull();
    } catch {
      return;
    }
    const runs = this.deps.ctx.companyStore.listAgentRuns(sessionId);
    const liveRunIds = new Set(
      runs.filter((r) => ACTIVE_RUN_STATUSES.has(r.status)).map((r) => r.id),
    );

    const schedCards = cardsFull.map((c) => ({
      id: c.id,
      column: c.column,
      blockedBy: c.blocked_by,
      assignedAgentRunIds: c.agents
        .filter((a) => !a.unassigned_at)
        .map((a) => a.agent_run_id),
    }));
    const schedRuns = [...new Set(schedCards.flatMap((c) => c.assignedAgentRunIds))].map(
      (id) => ({ agentRunId: id, live: liveRunIds.has(id) }),
    );

    const orphanIds = findOrphanedCards(schedCards, schedRuns);
    if (orphanIds.length === 0) return;

    for (const cardId of orphanIds) {
      try {
        const card = cardsFull.find((c) => c.id === cardId);
        for (const a of card?.agents ?? []) {
          if (!a.unassigned_at && !liveRunIds.has(a.agent_run_id)) {
            kanban.unassignAgent(cardId, a.agent_run_id);
          }
        }
        kanban.moveCard(cardId, 'todo');
        kanban.addComment(
          cardId,
          'scheduler',
          null,
          '[AUTO] Reset to `todo`: the assigned agent ended without completing the card ' +
            '(worker died / reconciled away mid-task). Re-dispatching.',
        );
        console.log(
          `[company s=${sessionId}] reconciler: card ${cardId} orphaned (agent died mid-task) — reset to todo`,
        );
      } catch {
        /* best-effort — a single card failure must not abort the sweep */
      }
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
      // C3 — proactive board nudge: idle master + ready todo cards + zero
      // active subordinates → suggest dispatching. Logic lives in the pure
      // scheduler/next-card-nudge.ts module; this is only the shell.
      this.maybeNudgeNextCard(now);
      return;
    }

    // Master dead: revive for a pending decision the inbox heartbeat won't see.
    // Shared dedup: skip if a resurrect already fired recently — the supervisor
    // (or a prior tick) may have revived the master through MasterLifecycle.
    if (
      stalled.length > 0 &&
      !this.recentlyNudged('c:resurrect', now) &&
      !this.deps.master.resurrectedWithinMs(COOLDOWN_RESURRECT_MS)
    ) {
      this.recordNudge('c:resurrect', now);
      this.deps.master.notify(
        '[SYSTEM] A subordinate is blocked awaiting your decision and your run had ended. ' +
        'Resuming so you can review the pending plan/question/tasks on the board and respond.',
      );
      this.publishNudge({ case: 'resurrect', reason: 'decision_pending' });
      console.log(`[company s=${sessionId}] master nudge (resurrect): ${stalled.length} pending decision(s), master dead`);
    }
  }

  /** C3 — shell for the pure next-card nudge (scheduler/next-card-nudge.ts). */
  private maybeNudgeNextCard(now: number): void {
    const kanban = this.deps.kanban;
    if (!kanban) return;
    try {
      const runs = this.deps.ctx.companyStore.listAgentRuns(this.deps.ctx.companySessionId);
      const masterRow = runs.find((r) => r.role === 'master');
      const decision = evaluateNextCardNudge({
        masterAlive: this.deps.master.isAlive,
        masterIdleMs: now - parseSqliteUtc(masterRow?.updated_at),
        activeSubordinateCount: runs.filter(
          (r) => r.role !== 'master' && ACTIVE_RUN_STATUSES.has(r.status),
        ).length,
        readyTodoCount: countReadyTodoCards(kanban.listCardsFull()),
        nowMs: now,
        lastNudgeAtMs: this.lastNextCardNudgeAt,
        idleThresholdMs: readNextCardIdleMs(),
      });
      if (!decision.nudge) return;
      this.lastNextCardNudgeAt = now;
      this.deps.master.notify(decision.message);
      this.publishNudge({ case: 'next_card', reason: 'ready_cards', readyCount: decision.readyCount });
      console.log(
        `[company s=${this.deps.ctx.companySessionId}] master nudge (next_card): ${decision.readyCount} ready todo card(s), idle master`,
      );
    } catch { /* nudge must never break the sweep */ }
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
    case: 'decision' | 'inbox' | 'resurrect' | 'next_card';
    agentRunId?: number;
    role?: string;
    kind?: 'plan' | 'question' | 'tasks';
    messageId?: number;
    reason?: string;
    ageMs?: number;
    /** next_card only — how many ready todo cards triggered the nudge. */
    readyCount?: number;
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
