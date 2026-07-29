import { describe, it, expect, beforeEach } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  createKanbanSlice,
  type KanbanSlice,
} from '@apps/dashboard/state/company/kanbanSlice.js';
import type { KanbanCardFull } from '@mcp/company-contracts';

type Store = UseBoundStore<StoreApi<KanbanSlice>>;

const SESSION_ID = '00000000-0000-4000-8000-000000000007';
const UNKNOWN_SESSION_ID = '00000000-0000-4000-8000-000000000099';
const CARD_1_ID = '00000000-0000-4000-8000-000000000101';
const CARD_2_ID = '00000000-0000-4000-8000-000000000102';
const UNKNOWN_CARD_ID = '00000000-0000-4000-8000-000000000999';
const COMMENT_ID = '00000000-0000-4000-8000-000000000201';
const ITEM_1_ID = '00000000-0000-4000-8000-000000000301';
const ITEM_2_ID = '00000000-0000-4000-8000-000000000302';
const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000401';

function makeStore(): Store {
  return create<KanbanSlice>()(createKanbanSlice);
}

function card(overrides: Partial<KanbanCardFull> = {}): KanbanCardFull {
  return {
    id: CARD_1_ID,
    seq: 1,
    company_session_id: SESSION_ID,
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
      const slot = store.getState().kanban.get(UNKNOWN_SESSION_ID);
      expect(slot).toBeUndefined();
    });

    it('kanbanEnsure creates a slot once and is idempotent', () => {
      store.getState().kanbanEnsure(SESSION_ID);
      const after = store.getState().kanban.get(SESSION_ID);
      expect(after).toBeDefined();
      expect(after?.initialized).toBe(false);
      store.getState().kanbanEnsure(SESSION_ID);
      expect(store.getState().kanban.get(SESSION_ID)).toBe(after);
    });

    it('kanbanHydrate sets initialized + replaces card map', () => {
      store.getState().kanbanHydrate(SESSION_ID, [
        card({ id: CARD_1_ID }),
        card({ id: CARD_2_ID }),
      ]);
      const slot = store.getState().kanban.get(SESSION_ID)!;
      expect(slot.initialized).toBe(true);
      expect(slot.cards.size).toBe(2);
      expect(slot.cards.get(CARD_1_ID)?.id).toBe(CARD_1_ID);
    });

    it('kanbanReset drops the slot entirely', () => {
      store.getState().kanbanHydrate(SESSION_ID, [card({ id: CARD_1_ID })]);
      store.getState().kanbanReset(SESSION_ID);
      expect(store.getState().kanban.has(SESSION_ID)).toBe(false);
    });
  });

  describe('kanbanApplyEvent', () => {
    beforeEach(() => {
      store.getState().kanbanHydrate(SESSION_ID, [
        card({ id: CARD_1_ID, column: 'backlog', position: 0 }),
      ]);
    });

    it('upserts on kanban_card_created', () => {
      store.getState().kanbanApplyEvent(
        SESSION_ID,
        'kanban_card_created',
        card({ id: CARD_2_ID, title: 'fresh' }),
      );
      const slot = store.getState().kanban.get(SESSION_ID)!;
      expect(slot.cards.size).toBe(2);
      expect(slot.cards.get(CARD_2_ID)?.title).toBe('fresh');
    });

    it('moves a card across columns', () => {
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_card_moved', {
        cardId: CARD_1_ID,
        fromColumn: 'backlog',
        toColumn: 'in_progress',
        position: 3,
      });
      const moved = store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!;
      expect(moved.column).toBe('in_progress');
      expect(moved.position).toBe(3);
    });

    it('ignores moves for unknown cards', () => {
      const before = store.getState().kanban.get(SESSION_ID)!.cards;
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_card_moved', {
        cardId: UNKNOWN_CARD_ID,
        fromColumn: 'backlog',
        toColumn: 'done',
        position: 0,
      });
      expect(store.getState().kanban.get(SESSION_ID)!.cards).toBe(before);
    });

    it('patches a card on kanban_card_updated', () => {
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_card_updated', {
        cardId: CARD_1_ID,
        patch: { title: 'renamed', tag: 'bug' },
      });
      const card1 = store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!;
      expect(card1.title).toBe('renamed');
      expect(card1.tag).toBe('bug');
    });

    it('deletes a card', () => {
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_card_deleted', {
        cardId: CARD_1_ID,
      });
      expect(store.getState().kanban.get(SESSION_ID)!.cards.has(CARD_1_ID)).toBe(false);
    });

    it('appends a comment and dedupes by id on replay', () => {
      const comment = {
        id: COMMENT_ID,
        card_id: CARD_1_ID,
        author_role: 'master',
        agent_run_id: null,
        content: 'hello',
        created_at: '2025-01-01',
      };
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_comment_added', {
        cardId: CARD_1_ID,
        comment,
      });
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_comment_added', {
        cardId: CARD_1_ID,
        comment,
      });
      const c = store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!;
      expect(c.comments.length).toBe(1);
      expect(c.comments[0].content).toBe('hello');
    });

    it('merges checklist items by id', () => {
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_checklist_updated', {
        cardId: CARD_1_ID,
        items: [
          { id: ITEM_1_ID, card_id: CARD_1_ID, text: 'step 1', checked: false, position: 0 },
          { id: ITEM_2_ID, card_id: CARD_1_ID, text: 'step 2', checked: false, position: 1 },
        ],
      });
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_checklist_updated', {
        cardId: CARD_1_ID,
        items: [
          {
            id: ITEM_2_ID,
            card_id: CARD_1_ID,
            text: 'step 2 updated',
            checked: true,
            position: 1,
          },
        ],
      });
      const list = store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!.checklist;
      expect(list).toHaveLength(2);
      const second = list.find((x) => x.id === ITEM_2_ID)!;
      expect(second.checked).toBe(true);
      expect(second.text).toBe('step 2 updated');
    });

    it('removes a checklist item', () => {
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_checklist_updated', {
        cardId: CARD_1_ID,
        items: [
          {
            id: ITEM_1_ID,
            card_id: CARD_1_ID,
            text: 'step',
            checked: false,
            position: 0,
          },
        ],
      });
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_checklist_removed', {
        cardId: CARD_1_ID,
        itemId: ITEM_1_ID,
      });
      expect(
        store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!.checklist,
      ).toHaveLength(0);
    });

    it('adds dependency and marks blocked_by when the target is not done', () => {
      store.getState().kanbanHydrate(SESSION_ID, [
        card({ id: CARD_1_ID, column: 'todo' }),
        card({ id: CARD_2_ID, column: 'in_progress' }),
      ]);
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_dependency_added', {
        cardId: CARD_1_ID,
        dependsOnId: CARD_2_ID,
      });
      const c = store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!;
      expect(c.dependencies).toHaveLength(1);
      expect(c.blocked_by).toContain(CARD_2_ID);
    });

    it('does not block when the dependency target is done', () => {
      store.getState().kanbanHydrate(SESSION_ID, [
        card({ id: CARD_1_ID, column: 'todo' }),
        card({ id: CARD_2_ID, column: 'done' }),
      ]);
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_dependency_added', {
        cardId: CARD_1_ID,
        dependsOnId: CARD_2_ID,
      });
      const c = store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!;
      expect(c.blocked_by).toEqual([]);
    });

    it('removes a dependency and clears blocked_by', () => {
      store.getState().kanbanHydrate(SESSION_ID, [
        card({ id: CARD_1_ID, column: 'todo' }),
        card({ id: CARD_2_ID, column: 'in_progress' }),
      ]);
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_dependency_added', {
        cardId: CARD_1_ID,
        dependsOnId: CARD_2_ID,
      });
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_dependency_removed', {
        cardId: CARD_1_ID,
        dependsOnId: CARD_2_ID,
      });
      const c = store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!;
      expect(c.dependencies).toHaveLength(0);
      expect(c.blocked_by).toEqual([]);
    });

    it('assigns an agent and is idempotent', () => {
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_agent_assigned', {
        cardId: CARD_1_ID,
        agentRunId: AGENT_RUN_ID,
        role: 'reviewer',
      });
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_agent_assigned', {
        cardId: CARD_1_ID,
        agentRunId: AGENT_RUN_ID,
        role: 'reviewer',
      });
      const c = store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!;
      expect(c.agents).toHaveLength(1);
      expect(c.agents[0].agent_run_id).toBe(AGENT_RUN_ID);
    });

    it('unassigns an agent by stamping unassigned_at', () => {
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_agent_assigned', {
        cardId: CARD_1_ID,
        agentRunId: AGENT_RUN_ID,
        role: 'reviewer',
      });
      store.getState().kanbanApplyEvent(SESSION_ID, 'kanban_agent_unassigned', {
        cardId: CARD_1_ID,
        agentRunId: AGENT_RUN_ID,
      });
      const c = store.getState().kanban.get(SESSION_ID)!.cards.get(CARD_1_ID)!;
      expect(c.agents[0].unassigned_at).not.toBeNull();
    });

    it('ignores unknown event types', () => {
      const before = store.getState().kanban.get(SESSION_ID)!.cards;
      store.getState().kanbanApplyEvent(
        SESSION_ID,
        'kanban_card_morphed' as never,
        { foo: 1 },
      );
      expect(store.getState().kanban.get(SESSION_ID)!.cards).toBe(before);
    });
  });
});
