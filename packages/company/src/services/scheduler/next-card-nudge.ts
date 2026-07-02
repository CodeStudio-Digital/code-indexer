/**
 * next-card nudge (C3) — PURE decision logic for the RuntimeReconciler.
 *
 * When the master is ALIVE but idle (no active subordinates, its agent_run
 * row untouched for a while) and the board has ready `todo` cards (unblocked,
 * unassigned), the reconciler nudges it: "the board has work — dispatch it or
 * plan the graph". Kept OUT of RuntimeReconciler.ts (559 LOC pre-existing)
 * so the new logic is unit-testable without the reconciler harness.
 *
 * Cadence knobs mirror the reconciler's nudge conventions: an idle threshold
 * before the first nudge and a long cooldown so a stuck-but-nudged master is
 * reminded again later, never every sweep. `MCP_COMPANY_NEXT_CARD_NUDGE_MS`
 * overrides the idle threshold; `0` disables the nudge entirely.
 */

/** Master must look idle for this long before the first nudge (default 2 min). */
export const NEXT_CARD_IDLE_MS = 120_000;
/** Re-nudge a still-idle master at most this often. */
export const NEXT_CARD_COOLDOWN_MS = 5 * 60_000;

/** 0 = disabled. Non-numeric/negative → default; floored at 5s to avoid a hot loop. */
export function readNextCardIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCP_COMPANY_NEXT_CARD_NUDGE_MS;
  if (raw === undefined || raw === '') return NEXT_CARD_IDLE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return NEXT_CARD_IDLE_MS;
  if (n === 0) return 0;
  return Math.max(5_000, n);
}

/** Minimal card shape (structural — KanbanCardFull satisfies it). */
export interface NextCardCard {
  column: string;
  blocked_by: ReadonlyArray<number>;
  agents: ReadonlyArray<{ unassigned_at: string | null }>;
}

/** Ready = in `todo`, unblocked, with nobody currently assigned. */
export function countReadyTodoCards(cards: ReadonlyArray<NextCardCard>): number {
  let ready = 0;
  for (const c of cards) {
    if (c.column !== 'todo') continue;
    if (c.blocked_by.length > 0) continue;
    if (c.agents.some((a) => !a.unassigned_at)) continue;
    ready += 1;
  }
  return ready;
}

export interface NextCardNudgeInput {
  masterAlive: boolean;
  /** ms since the master's agent_run row was last updated (NaN = unknown). */
  masterIdleMs: number;
  /** Subordinate runs still consuming a slot (running, waiting_x, blocked). */
  activeSubordinateCount: number;
  readyTodoCount: number;
  /** Wall-clock now + last time THIS nudge fired (0 = never). */
  nowMs: number;
  lastNudgeAtMs: number;
  /** Resolved idle threshold (readNextCardIdleMs). 0 disables. */
  idleThresholdMs: number;
}

export type NextCardNudgeDecision =
  | { nudge: false }
  | { nudge: true; readyCount: number; message: string };

export function buildNextCardMessage(readyCount: number): string {
  return (
    `[SYSTEM] The board has ${readyCount} ready card(s) in todo (unblocked, unassigned) ` +
    `and no subordinate is active. Consider dispatching them — spawn_subordinate_agent ` +
    `with kanban_card_id, or structure the work first with kanban_plan_graph.`
  );
}

/** Pure gate: all conditions AND the cooldown must pass. */
export function evaluateNextCardNudge(input: NextCardNudgeInput): NextCardNudgeDecision {
  if (input.idleThresholdMs === 0) return { nudge: false };
  if (!input.masterAlive) return { nudge: false };
  if (input.activeSubordinateCount > 0) return { nudge: false };
  if (input.readyTodoCount < 1) return { nudge: false };
  if (!Number.isFinite(input.masterIdleMs) || input.masterIdleMs < input.idleThresholdMs) {
    return { nudge: false };
  }
  if (input.nowMs - input.lastNudgeAtMs < NEXT_CARD_COOLDOWN_MS) return { nudge: false };
  return {
    nudge: true,
    readyCount: input.readyTodoCount,
    message: buildNextCardMessage(input.readyTodoCount),
  };
}
