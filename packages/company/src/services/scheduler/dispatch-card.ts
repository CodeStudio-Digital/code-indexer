/**
 * dispatchCard — the single "recommend → spawn → assign → move → comment"
 * unit extracted from `CompanyScheduler.tick()` (C3) so BOTH consumers share
 * one implementation:
 *
 *   - the autonomous scheduler (per selected target, source `'scheduler'`),
 *   - the orchestrator's `dispatchCard(cardId, role?)` method behind the
 *     dashboard quick-dispatch route (source `'manual'`).
 *
 * Role resolution order:
 *   1. explicit `role` argument (quick-dispatch chip) — skips the recommender;
 *   2. `[role-hint: @x]` card comment (written by `kanban_plan_graph`) — a
 *      cheap read over the card's own comments;
 *   3. the embedding recommender (`deps.recommend`); never blind-guess.
 *
 * Visibility: scheduler-sourced dispatches publish the SAME
 * `scheduler_dispatched` / `scheduler_skipped` events as before (payload
 * unchanged); manual dispatches stay silent on that channel — the regular
 * kanban_* events (assign/move/comment) already narrate them.
 */
import type { KanbanCardFull } from '@mcp/company/types.js';
import type { CompanySessionId } from '@mcp/session-storage';
import type { CompanyRecommendFn } from './recommend-shim.js';
import type { SchedulerSpawn } from './spawn-port.js';

/** Matches the LAST `[role-hint: @some-role]` marker in a comment body. */
const ROLE_HINT_RE = /\[role-hint:\s*@([A-Za-z0-9_-]+)\s*\]/;

/** Minimal kanban surface dispatchCard needs (KanbanService satisfies it). */
export interface DispatchCardKanban {
  getCard(cardId: string): KanbanCardFull | null;
  assignAgent(cardId: string, agentRunId: string, role: string): unknown;
  moveCard(cardId: string, column: 'in_progress'): unknown;
  addComment(
    cardId: string,
    authorRole: string,
    agentRunId: string | null,
    content: string,
  ): unknown;
}

export interface DispatchCardDeps {
  sessionId: CompanySessionId;
  kanban: DispatchCardKanban;
  subordinates: SchedulerSpawn;
  /** Null tolerated: without a recommender an un-hinted card is skipped. */
  recommend: CompanyRecommendFn | null;
  /** Best-effort visibility publisher (scheduler source only). */
  publish?: (event: string, data: Record<string, unknown>) => void;
}

export interface DispatchCardOpts {
  /** Explicit role — skips hint + recommender entirely. */
  role?: string;
  /** Who triggered this dispatch. Default `'scheduler'`. */
  source?: 'scheduler' | 'manual';
}

export type DispatchSkipReason =
  | 'card_not_found'
  | 'no_role'
  | 'recommend_failed'
  | 'spawn_failed';

export interface DispatchCardResult {
  ok: boolean;
  cardId: string;
  role?: string;
  agentRunId?: string;
  reason?: DispatchSkipReason;
  error?: string;
}

/**
 * Pure helper — extract the role hint from a card's comments. The LAST
 * hint wins (a re-plan may override an earlier hint). Exported for tests.
 */
export function extractRoleHint(
  comments: ReadonlyArray<{ content: string }> | undefined,
): string | null {
  if (!comments) return null;
  for (let i = comments.length - 1; i >= 0; i--) {
    const m = ROLE_HINT_RE.exec(comments[i]?.content ?? '');
    if (m) return m[1];
  }
  return null;
}

/** Dispatch one card. Never throws — every failure maps to a skip result. */
export async function dispatchCard(
  deps: DispatchCardDeps,
  cardId: string,
  opts: DispatchCardOpts = {},
): Promise<DispatchCardResult> {
  const source = opts.source ?? 'scheduler';
  const isScheduler = source === 'scheduler';
  const publish = (event: string, data: Record<string, unknown>): void => {
    if (!isScheduler) return; // manual dispatches ride the kanban_* events
    try { deps.publish?.(event, data); } catch { /* never break the dispatch */ }
  };

  let card: KanbanCardFull | null = null;
  try { card = deps.kanban.getCard(cardId); } catch { card = null; }
  if (!card) {
    return { ok: false, cardId, reason: 'card_not_found' };
  }
  const taskText = `${card.title}\n\n${card.description ?? ''}`.trim();

  // Resolve a role: explicit → hint → recommender. Never blind-guess.
  let role: string | null = opts.role?.trim() || null;
  let skipReason: DispatchSkipReason = 'no_role';
  if (!role) role = extractRoleHint(card.comments);
  if (!role && deps.recommend) {
    try {
      const rec = await deps.recommend({
        companySessionId: deps.sessionId, taskText, k: 1,
      });
      role = rec.recommendations[0]?.role ?? null;
    } catch (e) {
      skipReason = 'recommend_failed';
      console.warn(
        `[company s=${deps.sessionId}] dispatch-card: recommend failed for card ${cardId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (!role) {
    if (isScheduler) {
      console.log(
        `[company s=${deps.sessionId}] scheduler: no role resolved for card ${cardId} — skipping (wire the recommender shim to enable autonomous dispatch)`,
      );
    }
    publish('scheduler_skipped', { cardId, reason: skipReason });
    return { ok: false, cardId, reason: skipReason };
  }

  try {
    const spawned = await deps.subordinates.spawn({
      role,
      task: taskText,
      dispatchSource: source,
      // projectId omitted → spawn auto-resolves from the role's single
      // binding; a multi-bound/unbound role throws and we skip the card.
    });
    try {
      deps.kanban.assignAgent(cardId, spawned.agentRunId, role);
      deps.kanban.moveCard(cardId, 'in_progress');
      deps.kanban.addComment(
        cardId,
        isScheduler ? 'scheduler' : 'human',
        spawned.agentRunId,
        isScheduler
          ? `[AUTO] Scheduler dispatched @${role} (run=${spawned.agentRunId}) for this card while the master was idle.`
          : `Dispatched @${role} (run=${spawned.agentRunId}) for this card via quick-dispatch.`,
      );
    } catch { /* card bookkeeping is best-effort */ }
    publish('scheduler_dispatched', { cardId, role, agentRunId: spawned.agentRunId });
    console.log(
      `[company s=${deps.sessionId}] ${source}: dispatched @${role} (run=${spawned.agentRunId}) for card ${cardId}`,
    );
    return { ok: true, cardId, role, agentRunId: spawned.agentRunId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    publish('scheduler_skipped', { cardId, reason: 'spawn_failed' });
    console.warn(
      `[company s=${deps.sessionId}] ${source}: spawn failed for card ${cardId} role=${role}: ${msg}`,
    );
    return { ok: false, cardId, role, reason: 'spawn_failed', error: msg };
  }
}
