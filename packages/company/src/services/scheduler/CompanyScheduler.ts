/**
 * CompanyScheduler — autonomous dispatch loop (Phase 2 — "brain → hands").
 *
 * Runs INSIDE the company worker (one per session), so it spawns subordinates
 * via a DIRECT `subordinates.spawn(...)` call — not the main-thread RPC proxy,
 * which has a 60s timeout that a cold-container spawn would blow.
 *
 * Each tick (default 20s, gated behind `MCP_COMPANY_SCHEDULER=1`):
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
import type { KanbanColumn, KanbanTag } from '@mcp/company/types.js';
import {
  createKanbanPriorityPipeline,
  prioritizeKanban,
  type KanbanCardInput,
} from '@mcp/company/kanban-priority/index.js';
import { selectDispatchTargets, type SchedulerCard } from './dispatch-core.js';
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

export function schedulerEnabled(): boolean {
  return process.env.MCP_COMPANY_SCHEDULER === '1';
}

export class CompanyScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: CompanySchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    if (!schedulerEnabled()) return; // opt-in; default off until validated on-device
    // Loud, unmissable confirmation that the new code is live AND the flag was
    // read — so an operator can tell "is the scheduler actually armed?" from the
    // server log without guessing.
    console.log(
      `[company s=${this.deps.ctx.companySessionId}] 🤖 AUTONOMOUS SCHEDULER ARMED ` +
      `(MCP_COMPANY_SCHEDULER=1, tick=${tickMs()}ms, maxPerSweep=${maxPerSweep()}) — ` +
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

    const targets = selectDispatchTargets({
      prioritizedCards,
      runningCount,
      concurrencyLimit: this.deps.concurrencyLimit,
      maxPerSweep: maxPerSweep(),
    });
    if (targets.length === 0) return;

    const recommend = getGlobalCompanyRecommend();
    for (const cardId of targets) {
      const card = byId.get(cardId);
      if (!card) continue;
      const taskText = `${card.title}\n\n${card.description ?? ''}`.trim();

      // Resolve a role. The embedding recommender is the brain; never guess.
      let role: string | null = null;
      if (recommend) {
        try {
          const rec = await recommend({ companySessionId: sessionId, taskText, k: 1 });
          role = rec.recommendations[0]?.role ?? null;
        } catch (e) {
          console.warn(
            `[company s=${sessionId}] scheduler: recommend failed for card ${cardId}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (!role) {
        console.log(
          `[company s=${sessionId}] scheduler: no role resolved for card ${cardId} — skipping (wire the recommender shim to enable autonomous dispatch)`,
        );
        continue;
      }

      try {
        const spawned = await this.deps.subordinates.spawn({
          role,
          task: taskText,
          // projectId omitted → spawn auto-resolves from the role's single
          // binding; a multi-bound/unbound role throws and we skip the card.
        });
        try {
          this.deps.kanban.assignAgent(cardId, spawned.agentRunId, role);
          this.deps.kanban.moveCard(cardId, 'in_progress');
          this.deps.kanban.addComment(
            cardId,
            'scheduler',
            spawned.agentRunId,
            `[AUTO] Scheduler dispatched @${role} (run=${spawned.agentRunId}) for this card while the master was idle.`,
          );
        } catch { /* card bookkeeping is best-effort */ }
        console.log(
          `[company s=${sessionId}] scheduler: dispatched @${role} (run=${spawned.agentRunId}) for card ${cardId}`,
        );
      } catch (e) {
        console.warn(
          `[company s=${sessionId}] scheduler: spawn failed for card ${cardId} role=${role}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : 0;
  }
}
