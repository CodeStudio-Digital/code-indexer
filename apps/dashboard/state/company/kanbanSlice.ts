/**
 * Authoritative kanban card state keyed by company session id.
 *
 * Phase 0 deliberately keeps the SAME wire event names the server emits
 * today (`kanban_card_created`, `kanban_comment_added`, etc.) so this
 * slice is a drop-in replacement for the inline reducer that used to
 * live in `useCompanyStream.handleKanbanEvent`. Phase 2 renames the
 * server-side names to match `@mcp/company-contracts` and the
 * compatibility branches here will be removed.
 *
 * SSE is the single source of truth for mutations once the initial REST
 * load runs. Phase 2 will drop the post-mutation `refreshCard` calls in
 * `useKanbanState` and rely on backend broadcast for every change.
 */
import type { StateCreator } from 'zustand';
import type {
  KanbanCardFull,
  KanbanChecklistItem,
  KanbanComment,
} from '@mcp/company-contracts';
import { INITIAL_KANBAN_STATE, type KanbanState } from './types.js';

export interface KanbanSlice {
  kanban: Map<number, KanbanState>;

  kanbanEnsure: (sessionId: number) => void;
  kanbanSetLoading: (sessionId: number, loading: boolean) => void;
  kanbanSetError: (sessionId: number, error: string | null) => void;
  /** Replace all cards (initial REST load). */
  kanbanHydrate: (sessionId: number, cards: KanbanCardFull[]) => void;
  /** Apply a single SSE event from the server. */
  kanbanApplyEvent: (sessionId: number, eventType: string, data: unknown) => void;
  /** Upsert one card (after REST refreshCard). */
  kanbanUpsertCard: (sessionId: number, card: KanbanCardFull) => void;
  /** Remove one card. */
  kanbanRemoveCard: (sessionId: number, cardId: number) => void;
  /** Drop the slot entirely. */
  kanbanReset: (sessionId: number) => void;
}

function withSlot(
  prev: Map<number, KanbanState>,
  sessionId: number,
  patch: (slot: KanbanState) => KanbanState,
): Map<number, KanbanState> {
  const next = new Map(prev);
  const current = next.get(sessionId) ?? INITIAL_KANBAN_STATE;
  next.set(sessionId, patch(current));
  return next;
}

function withCards(
  prev: Map<number, KanbanState>,
  sessionId: number,
  patch: (cards: Map<number, KanbanCardFull>) => Map<number, KanbanCardFull>,
): Map<number, KanbanState> {
  return withSlot(prev, sessionId, (slot) => ({ ...slot, cards: patch(slot.cards) }));
}

export const createKanbanSlice: StateCreator<KanbanSlice, [], [], KanbanSlice> = (set) => ({
  kanban: new Map(),

  kanbanEnsure: (sessionId) =>
    set((state) => {
      if (state.kanban.has(sessionId)) return state;
      const next = new Map(state.kanban);
      next.set(sessionId, INITIAL_KANBAN_STATE);
      return { kanban: next };
    }),

  kanbanSetLoading: (sessionId, loading) =>
    set((state) => ({
      kanban: withSlot(state.kanban, sessionId, (slot) => ({ ...slot, loading })),
    })),

  kanbanSetError: (sessionId, error) =>
    set((state) => ({
      kanban: withSlot(state.kanban, sessionId, (slot) => ({ ...slot, error })),
    })),

  kanbanHydrate: (sessionId, cards) =>
    set((state) => ({
      kanban: withSlot(state.kanban, sessionId, (slot) => ({
        ...slot,
        cards: new Map(cards.map((c) => [c.id, c])),
        initialized: true,
        error: null,
      })),
    })),

  kanbanUpsertCard: (sessionId, card) =>
    set((state) => ({
      kanban: withCards(state.kanban, sessionId, (prev) => {
        const next = new Map(prev);
        next.set(card.id, card);
        return next;
      }),
    })),

  kanbanRemoveCard: (sessionId, cardId) =>
    set((state) => ({
      kanban: withCards(state.kanban, sessionId, (prev) => {
        const next = new Map(prev);
        next.delete(cardId);
        return next;
      }),
    })),

  kanbanReset: (sessionId) =>
    set((state) => {
      if (!state.kanban.has(sessionId)) return state;
      const next = new Map(state.kanban);
      next.delete(sessionId);
      return { kanban: next };
    }),

  kanbanApplyEvent: (sessionId, eventType, data) =>
    set((state) => ({
      kanban: withCards(state.kanban, sessionId, (cards) =>
        reduceKanbanEvent(cards, eventType, data),
      ),
    })),
});

// ─── Pure event reducer ───────────────────────────────────────

function reduceKanbanEvent(
  cards: Map<number, KanbanCardFull>,
  eventType: string,
  data: unknown,
): Map<number, KanbanCardFull> {
  switch (eventType) {
    case 'kanban_card_created':
      return upsertCard(cards, data as KanbanCardFull);

    case 'kanban_card_moved':
      return moveCard(cards, data as KanbanMovedEvent);

    case 'kanban_card_updated':
      return updateCard(cards, data as KanbanUpdatedEvent);

    case 'kanban_card_deleted':
      return deleteCard(cards, (data as { cardId: number }).cardId);

    case 'kanban_comment_added':
      return appendComment(cards, data as KanbanCommentAddedEvent);

    case 'kanban_checklist_updated':
      return mergeChecklist(cards, data as KanbanChecklistUpdatedEvent);

    case 'kanban_checklist_removed':
      return removeChecklistItem(cards, data as KanbanChecklistRemovedEvent);

    case 'kanban_dependency_added':
      return addDependency(cards, data as KanbanDependencyEvent);

    case 'kanban_dependency_removed':
      return removeDependency(cards, data as KanbanDependencyEvent);

    case 'kanban_agent_assigned':
      return assignAgent(cards, data as KanbanAgentAssignedEvent);

    case 'kanban_agent_unassigned':
      return unassignAgent(cards, data as KanbanAgentUnassignedEvent);

    default:
      return cards;
  }
}

// ─── Event payload shapes (server-current names) ──────────────

interface KanbanMovedEvent {
  cardId: number;
  fromColumn: string;
  toColumn: string;
  position: number;
}
interface KanbanUpdatedEvent {
  cardId: number;
  patch: Partial<KanbanCardFull>;
}
interface KanbanCommentAddedEvent {
  cardId: number;
  comment: KanbanComment;
}
interface KanbanChecklistUpdatedEvent {
  cardId: number;
  items: KanbanChecklistItem[];
}
interface KanbanChecklistRemovedEvent {
  cardId: number;
  itemId: number;
}
interface KanbanDependencyEvent {
  cardId: number;
  dependsOnId: number;
}
interface KanbanAgentAssignedEvent {
  cardId: number;
  agentRunId: number;
  role: string;
}
interface KanbanAgentUnassignedEvent {
  cardId: number;
  agentRunId: number;
}

// ─── Individual reducers ──────────────────────────────────────

function upsertCard(
  cards: Map<number, KanbanCardFull>,
  card: KanbanCardFull,
): Map<number, KanbanCardFull> {
  const next = new Map(cards);
  next.set(card.id, card);
  return next;
}

function moveCard(
  cards: Map<number, KanbanCardFull>,
  ev: KanbanMovedEvent,
): Map<number, KanbanCardFull> {
  const existing = cards.get(ev.cardId);
  if (!existing) return cards;
  const next = new Map(cards);
  next.set(ev.cardId, {
    ...existing,
    column: ev.toColumn as KanbanCardFull['column'],
    position: ev.position,
  });
  return next;
}

function updateCard(
  cards: Map<number, KanbanCardFull>,
  ev: KanbanUpdatedEvent,
): Map<number, KanbanCardFull> {
  const existing = cards.get(ev.cardId);
  if (!existing) return cards;
  const next = new Map(cards);
  next.set(ev.cardId, { ...existing, ...ev.patch });
  return next;
}

function deleteCard(
  cards: Map<number, KanbanCardFull>,
  cardId: number,
): Map<number, KanbanCardFull> {
  if (!cards.has(cardId)) return cards;
  const next = new Map(cards);
  next.delete(cardId);
  return next;
}

function appendComment(
  cards: Map<number, KanbanCardFull>,
  ev: KanbanCommentAddedEvent,
): Map<number, KanbanCardFull> {
  const existing = cards.get(ev.cardId);
  if (!existing) return cards;
  // Dedup by comment id so SSE replay is idempotent.
  if (existing.comments.some((c) => c.id === ev.comment.id)) return cards;
  const next = new Map(cards);
  next.set(ev.cardId, {
    ...existing,
    comments: [...existing.comments, ev.comment],
  });
  return next;
}

function mergeChecklist(
  cards: Map<number, KanbanCardFull>,
  ev: KanbanChecklistUpdatedEvent,
): Map<number, KanbanCardFull> {
  const existing = cards.get(ev.cardId);
  if (!existing) return cards;
  const merged = [...existing.checklist];
  for (const item of ev.items) {
    const idx = merged.findIndex((i) => i.id === item.id);
    if (idx >= 0) merged[idx] = item;
    else merged.push(item);
  }
  const next = new Map(cards);
  next.set(ev.cardId, { ...existing, checklist: merged });
  return next;
}

function removeChecklistItem(
  cards: Map<number, KanbanCardFull>,
  ev: KanbanChecklistRemovedEvent,
): Map<number, KanbanCardFull> {
  const existing = cards.get(ev.cardId);
  if (!existing) return cards;
  const filtered = existing.checklist.filter((i) => i.id !== ev.itemId);
  if (filtered.length === existing.checklist.length) return cards;
  const next = new Map(cards);
  next.set(ev.cardId, { ...existing, checklist: filtered });
  return next;
}

function addDependency(
  cards: Map<number, KanbanCardFull>,
  ev: KanbanDependencyEvent,
): Map<number, KanbanCardFull> {
  const existing = cards.get(ev.cardId);
  if (!existing) return cards;
  if (existing.dependencies.some((d) => d.depends_on_id === ev.dependsOnId)) return cards;

  const depCard = cards.get(ev.dependsOnId);
  const blockedBy = [...existing.blocked_by];
  if (depCard && depCard.column !== 'done' && !blockedBy.includes(ev.dependsOnId)) {
    blockedBy.push(ev.dependsOnId);
  }

  const next = new Map(cards);
  next.set(ev.cardId, {
    ...existing,
    dependencies: [
      ...existing.dependencies,
      {
        id: 0,
        card_id: ev.cardId,
        depends_on_id: ev.dependsOnId,
        created_at: new Date().toISOString(),
      },
    ],
    blocked_by: blockedBy,
  });
  return next;
}

function removeDependency(
  cards: Map<number, KanbanCardFull>,
  ev: KanbanDependencyEvent,
): Map<number, KanbanCardFull> {
  const existing = cards.get(ev.cardId);
  if (!existing) return cards;
  const next = new Map(cards);
  next.set(ev.cardId, {
    ...existing,
    dependencies: existing.dependencies.filter((d) => d.depends_on_id !== ev.dependsOnId),
    blocked_by: existing.blocked_by.filter((id) => id !== ev.dependsOnId),
  });
  return next;
}

function assignAgent(
  cards: Map<number, KanbanCardFull>,
  ev: KanbanAgentAssignedEvent,
): Map<number, KanbanCardFull> {
  const existing = cards.get(ev.cardId);
  if (!existing) return cards;
  const already = existing.agents.some(
    (a) => a.agent_run_id === ev.agentRunId && !a.unassigned_at,
  );
  if (already) return cards;
  const next = new Map(cards);
  next.set(ev.cardId, {
    ...existing,
    agents: [
      ...existing.agents,
      {
        id: 0,
        card_id: ev.cardId,
        agent_run_id: ev.agentRunId,
        role: ev.role,
        assigned_at: new Date().toISOString(),
        unassigned_at: null,
      },
    ],
  });
  return next;
}

function unassignAgent(
  cards: Map<number, KanbanCardFull>,
  ev: KanbanAgentUnassignedEvent,
): Map<number, KanbanCardFull> {
  const existing = cards.get(ev.cardId);
  if (!existing) return cards;
  const next = new Map(cards);
  next.set(ev.cardId, {
    ...existing,
    agents: existing.agents.map((a) =>
      a.agent_run_id === ev.agentRunId && !a.unassigned_at
        ? { ...a, unassigned_at: new Date().toISOString() }
        : a,
    ),
  });
  return next;
}
