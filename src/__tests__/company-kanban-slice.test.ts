import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createKanbanSlice,
  type KanbanSlice,
} from '@apps/dashboard/state/company/kanbanSlice.js';
import type { KanbanCardFull } from '@mcp/company-contracts';

type Store = UseBoundStore<StoreApi<KanbanSlice>>;

function makeStore(): Store {
  return create<KanbanSlice>()(createKanbanSlice);
}

function card(overrides: Partial<KanbanCardFull> = {}): KanbanCardFull {
  return {
    id: 1,
    company_session_id: 42,
    title: 'Test card',
    description: '',
    column: 'backlog',
    position: 0,
    tag: null,
    created_by: 'human',
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    archive_id: null,
    checklist: [],
    comments: [],
    agents: [],
    dependencies: [],
    blocked_by: [],
    ...overrides,
  };
}

describe('kanbanSlice', () => {
  let store: Store;

  beforeEach(() => {
    store = makeStore();
  });

  describe('lifecycle', () => {
    it('returns empty state for unknown sessions via the empty default', () => {
      const slot = store.getState().kanban.get(99);
      expect(slot).toBeUndefined();
    });

    it('kanbanEnsure creates a slot once and is idempotent', () => {
      store.getState().kanbanEnsure(7);
      const after = store.getState().kanban.get(7);
      expect(after).toBeDefined();
      expect(after?.initialized).toBe(false);
      store.getState().kanbanEnsure(7);
      expect(store.getState().kanban.get(7)).toBe(after);
    });

    it('kanbanHydrate sets initialized + replaces card map', () => {
      store.getState().kanbanHydrate(7, [card({ id: 1 }), card({ id: 2 })]);
      const slot = store.getState().kanban.get(7)!;
      expect(slot.initialized).toBe(true);
      expect(slot.cards.size).toBe(2);
      expect(slot.cards.get(1)?.id).toBe(1);
    });

    it('kanbanReset drops the slot entirely', () => {
      store.getState().kanbanHydrate(7, [card({ id: 1 })]);
      store.getState().kanbanReset(7);
      expect(store.getState().kanban.has(7)).toBe(false);
    });
  });

  describe('kanbanApplyEvent', () => {
    beforeEach(() => {
      store.getState().kanbanHydrate(7, [card({ id: 1, column: 'backlog', position: 0 })]);
    });

    it('upserts on kanban_card_created', () => {
      store.getState().kanbanApplyEvent(7, 'kanban_card_created', card({ id: 2, title: 'fresh' }));
      const slot = store.getState().kanban.get(7)!;
      expect(slot.cards.size).toBe(2);
      expect(slot.cards.get(2)?.title).toBe('fresh');
    });

    it('moves a card across columns', () => {
      store.getState().kanbanApplyEvent(7, 'kanban_card_moved', {
        cardId: 1,
        fromColumn: 'backlog',
        toColumn: 'in_progress',
        position: 3,
      });
      const moved = store.getState().kanban.get(7)!.cards.get(1)!;
      expect(moved.column).toBe('in_progress');
      expect(moved.position).toBe(3);
    });

    it('ignores moves for unknown cards', () => {
      const before = store.getState().kanban.get(7)!.cards;
      store.getState().kanbanApplyEvent(7, 'kanban_card_moved', {
        cardId: 999,
        fromColumn: 'backlog',
        toColumn: 'done',
        position: 0,
      });
      expect(store.getState().kanban.get(7)!.cards).toBe(before);
    });

    it('patches a card on kanban_card_updated', () => {
      store.getState().kanbanApplyEvent(7, 'kanban_card_updated', {
        cardId: 1,
        patch: { title: 'renamed', tag: 'bug' },
      });
      const card1 = store.getState().kanban.get(7)!.cards.get(1)!;
      expect(card1.title).toBe('renamed');
      expect(card1.tag).toBe('bug');
    });

    it('deletes a card', () => {
      store.getState().kanbanApplyEvent(7, 'kanban_card_deleted', { cardId: 1 });
      expect(store.getState().kanban.get(7)!.cards.has(1)).toBe(false);
    });

    it('appends a comment and dedupes by id on replay', () => {
      const comment = {
        id: 10,
        card_id: 1,
        author_role: 'master',
        agent_run_id: null,
        content: 'hello',
        created_at: '2025-01-01',
      };
      store.getState().kanbanApplyEvent(7, 'kanban_comment_added', { cardId: 1, comment });
      store.getState().kanbanApplyEvent(7, 'kanban_comment_added', { cardId: 1, comment });
      const c = store.getState().kanban.get(7)!.cards.get(1)!;
      expect(c.comments.length).toBe(1);
      expect(c.comments[0].content).toBe('hello');
    });

    it('merges checklist items by id', () => {
      store.getState().kanbanApplyEvent(7, 'kanban_checklist_updated', {
        cardId: 1,
        items: [
          { id: 1, card_id: 1, text: 'step 1', checked: false, position: 0 },
          { id: 2, card_id: 1, text: 'step 2', checked: false, position: 1 },
        ],
      });
      store.getState().kanbanApplyEvent(7, 'kanban_checklist_updated', {
        cardId: 1,
        items: [{ id: 2, card_id: 1, text: 'step 2 updated', checked: true, position: 1 }],
      });
      const list = store.getState().kanban.get(7)!.cards.get(1)!.checklist;
      expect(list).toHaveLength(2);
      const second = list.find((x) => x.id === 2)!;
      expect(second.checked).toBe(true);
      expect(second.text).toBe('step 2 updated');
    });

    it('removes a checklist item', () => {
      store.getState().kanbanApplyEvent(7, 'kanban_checklist_updated', {
        cardId: 1,
        items: [{ id: 1, card_id: 1, text: 'step', checked: false, position: 0 }],
      });
      store.getState().kanbanApplyEvent(7, 'kanban_checklist_removed', { cardId: 1, itemId: 1 });
      expect(store.getState().kanban.get(7)!.cards.get(1)!.checklist).toHaveLength(0);
    });

    it('adds dependency and marks blocked_by when the target is not done', () => {
      store.getState().kanbanHydrate(7, [
        card({ id: 1, column: 'todo' }),
        card({ id: 2, column: 'in_progress' }),
      ]);
      store.getState().kanbanApplyEvent(7, 'kanban_dependency_added', {
        cardId: 1,
        dependsOnId: 2,
      });
      const c = store.getState().kanban.get(7)!.cards.get(1)!;
      expect(c.dependencies).toHaveLength(1);
      expect(c.blocked_by).toContain(2);
    });

    it('does not block when the dependency target is done', () => {
      store.getState().kanbanHydrate(7, [
        card({ id: 1, column: 'todo' }),
        card({ id: 2, column: 'done' }),
      ]);
      store.getState().kanbanApplyEvent(7, 'kanban_dependency_added', {
        cardId: 1,
        dependsOnId: 2,
      });
      const c = store.getState().kanban.get(7)!.cards.get(1)!;
      expect(c.blocked_by).toEqual([]);
    });

    it('removes a dependency and clears blocked_by', () => {
      store.getState().kanbanHydrate(7, [
        card({ id: 1, column: 'todo' }),
        card({ id: 2, column: 'in_progress' }),
      ]);
      store.getState().kanbanApplyEvent(7, 'kanban_dependency_added', { cardId: 1, dependsOnId: 2 });
      store.getState().kanbanApplyEvent(7, 'kanban_dependency_removed', { cardId: 1, dependsOnId: 2 });
      const c = store.getState().kanban.get(7)!.cards.get(1)!;
      expect(c.dependencies).toHaveLength(0);
      expect(c.blocked_by).toEqual([]);
    });

    it('assigns an agent and is idempotent', () => {
      store.getState().kanbanApplyEvent(7, 'kanban_agent_assigned', {
        cardId: 1,
        agentRunId: 100,
        role: 'reviewer',
      });
      store.getState().kanbanApplyEvent(7, 'kanban_agent_assigned', {
        cardId: 1,
        agentRunId: 100,
        role: 'reviewer',
      });
      const c = store.getState().kanban.get(7)!.cards.get(1)!;
      expect(c.agents).toHaveLength(1);
      expect(c.agents[0].agent_run_id).toBe(100);
    });

    it('unassigns an agent by stamping unassigned_at', () => {
      store.getState().kanbanApplyEvent(7, 'kanban_agent_assigned', {
        cardId: 1,
        agentRunId: 100,
        role: 'reviewer',
      });
      store.getState().kanbanApplyEvent(7, 'kanban_agent_unassigned', {
        cardId: 1,
        agentRunId: 100,
      });
      const c = store.getState().kanban.get(7)!.cards.get(1)!;
      expect(c.agents[0].unassigned_at).not.toBeNull();
    });

    it('ignores unknown event types', () => {
      const before = store.getState().kanban.get(7)!.cards;
      store.getState().kanbanApplyEvent(7, 'kanban_card_morphed' as never, { foo: 1 });
      expect(store.getState().kanban.get(7)!.cards).toBe(before);
    });
  });
});
