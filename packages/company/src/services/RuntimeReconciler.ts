import { RuntimeDecisionNudger } from './runtime-decision-nudger.js';
import { REESTABLISH_MAX_ATTEMPTS, autoReestablishEnabled, ACTIVE_RUN_STATUSES, readInterval, NUDGE_TICK_MS, COOLDOWN_RESURRECT_MS, readNudgeMs } from './runtime-reconciler-policy.js';
import type { RuntimeReconcilerDeps } from './runtime-reconciler-policy.js';
export type { RuntimeReconcilerDeps } from './runtime-reconciler-policy.js';
export { COOLDOWN_RESURRECT_MS } from './runtime-reconciler-policy.js';
/**
 * RuntimeReconciler — periodic sweep that keeps each agent-run file status
 * consistent with the runtime state of the orchestrator.
 *
 * Boot recovery already covers the cold-start path (`server.ts` calls
 * bundle startup recovery and `MasterInboxRouter.reviveIfPending`),
 * but doesn't help DURING a live session. If something kills the master
 * runner without updating its persisted bundle (worker thread crash,
 * uncaught throw inside a tool, OS-level OOM), the agent-run record stays
 * at `status='running'`
 * forever and the dashboard renders a status that doesn't match reality.
 *
 * Two responsibilities, one timer:
 *   1. Force `status='idle'` on agent-run records whose runtime says they're
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

import { MASTER_INBOX_SENTINEL } from '@mcp/company/services/MasterInboxRouter.js';

import { asAgentRunId } from '@mcp/session-storage';
import { isAutonomyActionAllowed, resolveAutonomy } from '@mcp/company/services/autonomy/autonomy-config.js';

import { findOrphanedCards } from '@mcp/company/services/scheduler/dispatch-core.js';

export class RuntimeReconciler {
  private readonly decisionNudger: RuntimeDecisionNudger;

  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Second timer dedicated to the re-nudge sweep (NUDGE_TICK_MS). */
  private nudgeTimer: ReturnType<typeof setInterval> | null = null;
  private nudging = false;
  /** Per-subordinate auto-reestablish attempt counter (crash-loop cap). Reset
   *  when the subordinate is observed healthy (tracked) again. */
  private readonly reestablishAttempts = new Map<string, number>();

  constructor(private readonly deps: RuntimeReconcilerDeps) {
    this.decisionNudger = new RuntimeDecisionNudger(deps);
  }

  private nudgeStalledMasterDecisions(): Promise<void> {
    return this.decisionNudger.nudgeStalledMasterDecisions();
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
    const runs = this.deps.ctx.companyFiles.listAgentRunsSync();
    const masterRow = runs.find((r) => r.role === 'master');
    if (!masterRow) return;
    const persistedSaysRunning =
      masterRow.status === 'running' ||
      masterRow.status === 'waiting_plan' ||
      masterRow.status === 'waiting_question' ||
      masterRow.status === 'waiting_tasks';
    if (!persistedSaysRunning) return;
    if (this.deps.master.isAlive) return;
    // Runtime says dead, DB says running — reconcile.
    await this.deps.ctx.companyFiles.updateAgentRunStatus(
      masterRow.id,
      'idle',
      'reconciled',
    );
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
    const runs = this.deps.ctx.companyFiles.listAgentRunsSync();
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
          await this.deps.ctx.companyFiles.updateAgentRunStatus(
            r.id,
            'error',
            'reconciler: runtime gone — re-establishing',
          );
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
      await this.deps.ctx.companyFiles.updateAgentRunStatus(
        r.id,
        'idle',
        'reconciled',
      );
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
    const runs = this.deps.ctx.companyFiles.listAgentRunsSync();
    const liveRunIds = new Set(
      runs.filter((r) => ACTIVE_RUN_STATUSES.has(r.status)).map((r) => r.id),
    );

    const schedCards = cardsFull.map((c) => ({
      id: c.id,
      column: c.column,
      blockedBy: c.blocked_by,
      assignedAgentRunIds: c.agents
        .filter((a) => !a.unassigned_at)
        .map((a) => asAgentRunId(a.agent_run_id)),
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
          if (
            !a.unassigned_at &&
            !liveRunIds.has(asAgentRunId(a.agent_run_id))
          ) {
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
    const pending = this.deps.ctx.companyFiles.listInboxMessagesSync({
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
}
