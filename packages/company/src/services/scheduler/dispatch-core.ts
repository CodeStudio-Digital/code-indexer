/**
 * Autonomous-scheduler decision core (Phase 2 — "brain → hands").
 *
 * PURE logic, no I/O, no orchestrator/worker coupling — so it is exhaustively
 * unit-testable. The live shell (worker-side scheduler service) feeds it a
 * snapshot of session state and acts on the decisions:
 *
 *   - `findOrphanedCards`   → cards stuck `in_progress` whose only worker died
 *     mid-task; the shell resets them to `todo` and emits an unblock signal so
 *     they re-enter the dispatch pool (self-repair / homeostasis).
 *   - `selectDispatchTargets` → the highest-priority UNBLOCKED, UNASSIGNED
 *     `todo`/`backlog` cards, capped by the number of free concurrency slots;
 *     the shell resolves a role per card (via the recommender) and spawns.
 *
 * Keeping role resolution OUT of this module is deliberate: the recommender is
 * async + embedding-backed and lives main-thread. This core only answers
 * "which cards, in what order, how many" — the questions that are pure
 * functions of the board + the running fleet.
 */

/** Columns a card can be dispatched FROM (not yet started). */
const DISPATCHABLE_COLUMNS = new Set(['backlog', 'todo']);

/** Minimal card shape the core needs. Structural — avoids importing the full
 *  KanbanCardFull and lets tests pass plain literals. */
export interface SchedulerCard {
  id: number;
  column: string;
  /** Ids of `depends_on` cards that are NOT yet `done` (store-computed). */
  blockedBy: number[];
  /** Agent runs currently assigned to this card (excludes unassigned). */
  assignedAgentRunIds: number[];
}

/** Minimal agent-run shape. */
export interface SchedulerRun {
  agentRunId: number;
  /** Whether this run is still doing useful work (running/waiting/etc.). A
   *  terminal/ghost run is NOT live. */
  live: boolean;
}

/**
 * Cards that are `in_progress` but whose every assigned agent is dead — the
 * worker crashed / was reconciled away mid-task, so the card would otherwise
 * sit forever showing "in progress" with nobody on it. The shell resets these
 * to `todo` so they re-enter the dispatch pool.
 *
 * A card with NO assigned agents in `in_progress` is also orphaned (it got
 * moved but never picked up). A card with at least one live agent is healthy.
 */
export function findOrphanedCards(
  cards: ReadonlyArray<SchedulerCard>,
  runs: ReadonlyArray<SchedulerRun>,
): number[] {
  const liveRunIds = new Set(runs.filter((r) => r.live).map((r) => r.agentRunId));
  const orphaned: number[] = [];
  for (const card of cards) {
    if (card.column !== 'in_progress') continue;
    const hasLiveAgent = card.assignedAgentRunIds.some((id) => liveRunIds.has(id));
    if (!hasLiveAgent) orphaned.push(card.id);
  }
  return orphaned;
}

export interface DispatchSelectionInput {
  /** Cards in priority order, highest first (e.g. from prioritizeKanban). */
  prioritizedCards: ReadonlyArray<SchedulerCard>;
  /** Live (running) subordinate count right now. */
  runningCount: number;
  /** Hard concurrency cap (ConcurrencyPolicy.limit). */
  concurrencyLimit: number;
  /** Optional extra ceiling on how many to dispatch in a single sweep, so the
   *  scheduler ramps up gradually instead of saturating the cap in one tick. */
  maxPerSweep?: number;
}

/**
 * Pick the cards to dispatch this sweep: walk `prioritizedCards` (already
 * ordered), keep those that are dispatchable (backlog/todo), UNBLOCKED
 * (no open dependency), and UNASSIGNED (nobody already on them), up to the
 * number of free concurrency slots. Returns card ids in dispatch order.
 *
 * Returns [] when the fleet is already at the cap — the scheduler never
 * exceeds the same limit the master's spawn path enforces.
 */
export function selectDispatchTargets(input: DispatchSelectionInput): number[] {
  const freeSlots = Math.max(0, input.concurrencyLimit - input.runningCount);
  if (freeSlots === 0) return [];
  const budget = input.maxPerSweep != null
    ? Math.min(freeSlots, Math.max(0, input.maxPerSweep))
    : freeSlots;
  if (budget === 0) return [];

  const targets: number[] = [];
  for (const card of input.prioritizedCards) {
    if (targets.length >= budget) break;
    if (!DISPATCHABLE_COLUMNS.has(card.column)) continue;
    if (card.blockedBy.length > 0) continue; // open dependency
    if (card.assignedAgentRunIds.length > 0) continue; // already being worked
    targets.push(card.id);
  }
  return targets;
}
