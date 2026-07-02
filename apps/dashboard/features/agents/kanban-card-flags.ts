/**
 * Pure card-derivation helpers for the kanban UI (C3). No React, no I/O —
 * unit-tested directly. Everything is defensive: the dashboard has no tsc
 * gate, so malformed cards must degrade to `false`, never throw.
 */
import type { KanbanCardFull } from '@mcp/company-contracts';

/** Comment prefix the autonomous scheduler writes when it dispatches a card. */
const AUTO_DISPATCH_PREFIX = '[AUTO] Scheduler dispatched';

/**
 * True when THIS card was put in progress by the autonomous scheduler —
 * source of truth is the durable `[AUTO] Scheduler dispatched …` comment
 * (persisted with the card, survives reloads; the SSE `scheduler_dispatched`
 * event ring would be lost on refresh). Only meaningful while the card is
 * still `in_progress`: once it moves on, the chip is history, not status.
 */
export function isAutoDispatched(card: Partial<KanbanCardFull> | null | undefined): boolean {
  if (!card || card.column !== 'in_progress') return false;
  const comments = Array.isArray(card.comments) ? card.comments : [];
  return comments.some(
    (c) =>
      c != null &&
      c.author_role === 'scheduler' &&
      typeof c.content === 'string' &&
      c.content.startsWith(AUTO_DISPATCH_PREFIX),
  );
}

/**
 * Cheap fingerprint of the fields that matter to priority recompute + role
 * suggestions. The auto-recompute debounce keys off this instead of Map
 * identity so unrelated churn (checklist ticks, comment chatter) doesn't
 * re-run the pipelines — and the recompute response itself (which mutates
 * NOTHING on the cards) can never re-trigger the loop.
 */
export function kanbanRecomputeFingerprint(
  cards: ReadonlyArray<Partial<KanbanCardFull>> | null | undefined,
): string {
  if (!Array.isArray(cards)) return '';
  return cards
    .map((c) => {
      const agents = Array.isArray(c.agents)
        ? c.agents.filter((a) => a && !a.unassigned_at).map((a) => a.role).sort().join(',')
        : '';
      const blocked = Array.isArray(c.blocked_by) ? [...c.blocked_by].sort().join(',') : '';
      return `${c.id}|${c.column}|${c.tag ?? ''}|${blocked}|${agents}|${c.title ?? ''}`;
    })
    .sort()
    .join(';');
}
