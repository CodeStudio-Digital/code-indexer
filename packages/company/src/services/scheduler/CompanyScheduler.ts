/**
 * CompanyScheduler — autonomous dispatch loop (Phase 2 — "brain → hands").
 *
 * Runs INSIDE the company worker (one per session), so it spawns subordinates
 * via a DIRECT `subordinates.spawn(...)` call — not the main-thread RPC proxy,
 * which has a 60s timeout that a cold-container spawn would blow.
 *
 * Each tick (default 20s; C2 — ON by default, killed live by
 * `autonomy.freeze`/`autonomy.scheduler=false` per session or the
 * `MCP_COMPANY_SCHEDULER='0'` env kill-switch, checked at EVERY tick):
 *   1. Only act when the MASTER IS NOT ALIVE — the scheduler fills the gaps
 *      while the master rests between turns. When a dispatched subordinate
 *      finishes, its completion notify resurrects the master to synthesize.
 *      This avoids racing the master's own delegation.
 *   2. Prioritize the board (`prioritizeKanban`, pure, in-worker) and pick the
 *      top UNBLOCKED + UNASSIGNED todo/backlog cards up to the free concurrency
 *      slots (`selectDispatchTargets`), capped to `maxPerSweep` per tick so the
 *      org ramps up gradually instead of saturating the cap in one go.
 *   3. Resolve a role per card via the embedding recommender shim
 *      (`getGlobalCompanyRecommend`); skip the card when no role can be resolved
 *      (never blind-guess a role).
 *   4. Spawn, then assign the agent to the card and move it to in_progress.
 *
 * Every step is best-effort and bounded; a failure on one card never aborts the
 * sweep. The hard concurrency cap is still enforced inside `subordinates.spawn`
 * (it throws when over) — `selectDispatchTargets` only sizes the batch.
 */
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { KanbanService } from '@mcp/company/services/KanbanService.js';
import type { MasterLifecycle } from '@mcp/company/services/MasterLifecycle.js';
import type { IMetaBusPublisher } from '@mcp/company/services/ports.js';
import type { KanbanColumn, KanbanTag } from '@mcp/company/types.js';
import {
  createKanbanPriorityPipeline,
  prioritizeKanban,
  type KanbanCardInput,
} from '@mcp/company/kanban-priority/index.js';
import {
  isAutonomyActionAllowed,
  resolveAutonomy,
} from '@mcp/company/services/autonomy/autonomy-config.js';
import type { AutonomyProvider } from '@mcp/company/services/autonomy/autonomy-provider.js';
import { selectDispatchTargets, type SchedulerCard } from './dispatch-core.js';
import { dispatchCard } from './dispatch-card.js';
import { getGlobalCompanyRecommend } from './recommend-shim.js';

const DEFAULT_TICK_MS = 20_000;
const DEFAULT_MAX_PER_SWEEP = 1;

/** Minimal spawn surface the scheduler needs — satisfied by SubordinateLifecycle. */
export interface SchedulerSpawn {
  spawn(spec: {
    role: string;
    task: string;
    projectId?: number;
  }): Promise<{ agentRunId: number; coderSessionId: number }>;
}

export interface CompanySchedulerDeps {
  ctx: SessionContext;
  kanban: KanbanService;
  master: Pick<MasterLifecycle, 'isAlive'>;
  subordinates: SchedulerSpawn;
  /** Hard concurrency cap (ConcurrencyPolicy.limit). */
  concurrencyLimit: number;
  /**
   * C1 — session metaBus publisher for organism-visibility events
   * (`scheduler_dispatched` / `scheduler_skipped` / `scheduler_sweep`).
   * Optional so test fixtures and older call-sites keep working; publish
   * failures never break the sweep.
   */
  bus?: Pick<IMetaBusPublisher, 'publish'>;
  /**
   * C2 — per-session autonomy config, consulted at the START of every tick
   * (not at boot) so `freeze` / `scheduler=false` kill the loop LIVE.
   * Optional: legacy callers/tests without it fall back to
   * `resolveAutonomy(null, process.env)` — never crash.
   */
  autonomy?: Pick<AutonomyProvider, 'get'>;
  /** Override for tests. */
  now?: () => number;
}

/** Agent-run statuses that consume a concurrency slot (mirror ConcurrencyPolicy intent). */
const ACTIVE_RUN_STATUSES = new Set<string>([
  'running', 'working',
  'waiting', 'waiting_plan', 'waiting_question', 'waiting_tasks',
  'reviewing', 'blocked',
]);

function tickMs(): number {
  const raw = Number(process.env.MCP_COMPANY_SCHEDULER_TICK_MS);
  return Number.isFinite(raw) && raw >= 2_000 ? raw : DEFAULT_TICK_MS;
}

function maxPerSweep(): number {
  const raw = Number(process.env.MCP_COMPANY_SCHEDULER_MAX_PER_SWEEP);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_PER_SWEEP;
}

export class CompanyScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: CompanySchedulerDeps) {}

  /** C2 — effective autonomy config; falls back to env+defaults when no
   *  provider was injected (legacy callers, narrow test fixtures). */
  private autonomyConfig() {
    return this.deps.autonomy
      ? this.deps.autonomy.get()
      : resolveAutonomy(null, process.env);
  }

  start(): void {
    if (this.timer) return;
    // C2 — ALWAYS arm the timer; the enable/freeze decision moved into the
    // tick so a session toggle (PATCH /config) or env kill-switch acts LIVE,
    // without restarting the worker. An off config costs one cheap check/20s.
    console.log(
      `[company s=${this.deps.ctx.companySessionId}] 🤖 AUTONOMOUS SCHEDULER ARMED ` +
      `(default ON — kill-switch: MCP_COMPANY_SCHEDULER=0 or autonomy.scheduler=false/freeze; ` +
      `tick=${tickMs()}ms, maxPerSweep=${maxPerSweep()}) — ` +
      `will dispatch unblocked cards while the master is idle.`,
    );
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.tick().finally(() => { this.running = false; });
    }, tickMs());
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

  /** One dispatch pass. Exposed for tests. */
  async tick(): Promise<void> {
    // C2 — live kill-switch: freeze / scheduler=false / env '0' make every
    // tick a no-op while the timer stays armed (re-enabling needs no restart).
    const cfg = this.autonomyConfig();
    if (!isAutonomyActionAllowed(cfg, 'scheduler')) return;
    // Division of labor: while the master is actively orchestrating, it owns
    // delegation — the scheduler only works the board during the master's
    // dormant gaps.
    if (this.deps.master.isAlive) return;

    const sessionId = this.deps.ctx.companySessionId;
    let cardsFull;
    try {
      cardsFull = this.deps.kanban.listCardsFull();
    } catch {
      return;
    }
    if (cardsFull.length === 0) return;

    // Running count from DB (excludes master) — sizes the batch; the hard cap
    // is still enforced by subordinates.spawn.
    const runs = this.deps.ctx.companyStore.listAgentRuns(sessionId);
    const runningCount = runs.filter(
      (r) => r.role !== 'master' && ACTIVE_RUN_STATUSES.has(r.status),
    ).length;

    // Reverse "blocks" map for the priority pipeline (who does each card block?).
    const blocksMap = new Map<number, number[]>();
    for (const card of cardsFull) {
      for (const dep of card.dependencies) {
        const list = blocksMap.get(dep.depends_on_id) ?? [];
        list.push(card.id);
        blocksMap.set(dep.depends_on_id, list);
      }
    }
    const priorityInput: KanbanCardInput[] = cardsFull.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description ?? '',
      column: c.column as KanbanColumn,
      tag: (c.tag ?? null) as KanbanTag,
      blocks: blocksMap.get(c.id) ?? [],
      blockedBy: c.blocked_by,
      assignedRoles: (c.agents ?? []).filter((a) => !a.unassigned_at).map((a) => a.role),
      createdAtMs: c.created_at ? new Date(c.created_at).getTime() : undefined,
      columnUpdatedAtMs: c.updated_at ? new Date(c.updated_at).getTime() : undefined,
    }));

    let orderedIds: number[];
    try {
      const pipeline = createKanbanPriorityPipeline();
      const result = await prioritizeKanban(pipeline, {
        queryId: `scheduler-${sessionId}-${this.nowMs()}`,
        cards: priorityInput,
        idleRoles: [],
      });
      orderedIds = result.ordered.map((c) => c.id);
    } catch {
      // Fall back to board order if the pipeline throws.
      orderedIds = cardsFull.map((c) => c.id);
    }

    // Map ordered ids back to the structural SchedulerCard shape.
    const byId = new Map(cardsFull.map((c) => [c.id, c]));
    const prioritizedCards: SchedulerCard[] = orderedIds
      .map((id) => byId.get(id))
      .filter((c): c is NonNullable<typeof c> => c != null)
      .map((c) => ({
        id: c.id,
        column: c.column,
        blockedBy: c.blocked_by,
        assignedAgentRunIds: c.agents.filter((a) => !a.unassigned_at).map((a) => a.agent_run_id),
      }));

    // C3 — soft WIP ceiling on in_progress. Only the scheduler respects it:
    // a human drag or an explicit master move can still exceed the limit.
    const inProgressCount = cardsFull.filter((c) => c.column === 'in_progress').length;
    const wipLimit = cfg.wipLimits?.in_progress ?? null;

    const targets = selectDispatchTargets({
      prioritizedCards,
      runningCount,
      concurrencyLimit: this.deps.concurrencyLimit,
      maxPerSweep: maxPerSweep(),
      wip: { inProgressCount, limit: wipLimit },
    });
    if (targets.length === 0) return;

    // C3 — the per-card "recommend → spawn → assign → move → comment" unit
    // lives in dispatch-card.ts, shared with the manual quick-dispatch route.
    const recommend = getGlobalCompanyRecommend();
    let dispatched = 0;
    for (const cardId of targets) {
      const result = await dispatchCard(
        {
          sessionId,
          kanban: {
            // Cards were just listed for prioritization — reuse the snapshot
            // instead of a second store read per target.
            getCard: (id) => byId.get(id) ?? null,
            assignAgent: (c, agentRunId, role) => this.deps.kanban.assignAgent(c, agentRunId, role),
            moveCard: (c, col) => this.deps.kanban.moveCard(c, col),
            addComment: (c, author, runId, content) =>
              this.deps.kanban.addComment(c, author, runId, content),
          },
          subordinates: this.deps.subordinates,
          recommend,
          publish: (event, data) => this.publishVisibility(event, data),
        },
        cardId,
        { source: 'scheduler' },
      );
      if (result.ok) dispatched += 1;
    }
    // Sweep summary only when something actually moved — silence is signal
    // (an all-quiet tick must not spam the session feed every 20s).
    if (dispatched > 0) {
      this.publishVisibility('scheduler_sweep', {
        dispatched,
        freeSlots: Math.max(0, this.deps.concurrencyLimit - runningCount - dispatched),
      });
    }
  }

  /**
   * C1 — best-effort visibility event on the session metaBus. Carries a
   * server-side `at` timestamp so SSE replays de-dup client-side instead
   * of re-stamping (and duplicating) on every reconnect.
   */
  private publishVisibility(event: string, data: Record<string, unknown>): void {
    try {
      this.deps.bus?.publish(event, {
        ...data,
        at: this.deps.now ? this.deps.now() : Date.now(),
      });
    } catch { /* visibility must never break the sweep */ }
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : 0;
  }
}
