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
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';

const DEFAULT_INTERVAL_MS = 45_000;

function readInterval(): number {
  const raw = process.env.MCP_COMPANY_RECONCILE_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 1_000 ? n : DEFAULT_INTERVAL_MS;
}

export interface RuntimeReconcilerDeps {
  ctx: SessionContext;
  master: MasterLifecycle;
  subordinates: SubordinateLifecycle;
  masterInbox: MasterInboxRouter;
  publisher: IMetaBusPublisher;
}

export class RuntimeReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: RuntimeReconcilerDeps) {}

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
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
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
}
