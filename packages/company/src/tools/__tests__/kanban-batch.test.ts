/**
 * kanban_create_card / kanban_move_card — batch forms. Telemetry showed
 * masters planning boards one card per TURN (91 consecutive create→create
 * turn pairs, 71 move→move); the batch array collapses a board plan into a
 * single call. Per-item isolation (NOT atomic): cards are independent, so a
 * blocked move fails only its entry.
 */
import { describe, it, expect } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import { kanbanCreateCardTool, kanbanMoveCardTool } from '../kanban-batch.js';

interface StubCard { id: number; title: string; column: string; position: number; blocked_by: number[] }

function stubOrchestrator() {
  const cards = new Map<number, StubCard>();
  let nextId = 1;
  const orchestrator = {
    kanbanCreateCard(input: { title: string; column?: string }) {
      const card: StubCard = {
        id: nextId++,
        title: input.title,
        column: input.column ?? 'backlog',
        position: cards.size,
        blocked_by: [],
      };
      cards.set(card.id, card);
      return card;
    },
    kanbanGetCard(id: number) {
      return cards.get(id) ?? null;
    },
    kanbanMoveCard(id: number, column: string, position?: number) {
      const card = cards.get(id);
      if (!card) throw new Error(`card #${id} not found`);
      card.column = column;
      card.position = position ?? card.position;
      return card;
    },
  } as unknown as CompanyOrchestrator;
  return { orchestrator, cards };
}

const ctx = {} as ToolContext;

describe('kanban_create_card — batch', () => {
  it('creates several cards in one call and reports every id', async () => {
    const { orchestrator } = stubOrchestrator();
    const tool = kanbanCreateCardTool(orchestrator);
    const res = await tool.handler(
      {
        cards: [
          { title: 'Setup backend', checklist: ['scaffold', 'db'] },
          { title: 'Build UI', column: 'backlog' },
          { title: 'Write docs', tag: 'documentation' },
        ],
      },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('3/3 succeeded');
    expect(res.content).toContain('[1/3] #1 "Setup backend"');
    expect(res.content).toContain('[3/3] #3 "Write docs"');
  });

  it('keeps the single form working', async () => {
    const { orchestrator } = stubOrchestrator();
    const tool = kanbanCreateCardTool(orchestrator);
    const res = await tool.handler({ title: 'Solo card' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('#1 "Solo card" → backlog');
  });

  it('rejects mixing forms, empty batches and oversized batches', async () => {
    const { orchestrator } = stubOrchestrator();
    const tool = kanbanCreateCardTool(orchestrator);

    const mixed = await tool.handler({ title: 'x', cards: [{ title: 'y' }] }, ctx);
    expect(mixed.isError).toBe(true);
    expect(mixed.content).toContain('not both');

    expect((await tool.handler({ cards: [] }, ctx)).isError).toBe(true);

    const oversized = await tool.handler(
      { cards: Array.from({ length: 16 }, (_, i) => ({ title: `c${i}` })) },
      ctx,
    );
    expect(oversized.isError).toBe(true);
    expect(oversized.content).toContain('max 15');
  });

  it('rejects an entry without title naming its index', async () => {
    const { orchestrator } = stubOrchestrator();
    const tool = kanbanCreateCardTool(orchestrator);
    const res = await tool.handler({ cards: [{ title: 'ok' }, { description: 'no title' }] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('cards[1]');
  });
});

describe('kanban_move_card — batch with per-item isolation', () => {
  it('a blocked card fails only its entry; the rest still move', async () => {
    const { orchestrator, cards } = stubOrchestrator();
    const create = kanbanCreateCardTool(orchestrator);
    await create.handler({ cards: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] }, ctx);
    cards.get(2)!.blocked_by = [1]; // B is blocked by A

    const move = kanbanMoveCardTool(orchestrator);
    const res = await move.handler(
      {
        moves: [
          { card_id: 1, column: 'in_progress' },
          { card_id: 2, column: 'in_progress' }, // blocked → fails
          { card_id: 3, column: 'review' },
        ],
      },
      ctx,
    );
    expect(res.isError).toBeFalsy(); // partial success is not a tool error
    expect(res.content).toContain('2/3 succeeded, 1 failed');
    expect(res.content).toContain('[2/3] FAILED: Card #2 is blocked by cards: 1');
    expect(cards.get(1)!.column).toBe('in_progress');
    expect(cards.get(2)!.column).toBe('backlog'); // untouched
    expect(cards.get(3)!.column).toBe('review');
  });

  it('is an error only when EVERY entry fails', async () => {
    const { orchestrator } = stubOrchestrator();
    const move = kanbanMoveCardTool(orchestrator);
    const res = await move.handler(
      { moves: [{ card_id: 99, column: 'done' }, { card_id: 100, column: 'done' }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain('0/2 succeeded');
  });

  it('keeps the single form (including the blocked-card guidance) working', async () => {
    const { orchestrator, cards } = stubOrchestrator();
    const create = kanbanCreateCardTool(orchestrator);
    await create.handler({ cards: [{ title: 'A' }, { title: 'B' }] }, ctx);
    cards.get(2)!.blocked_by = [1];

    const move = kanbanMoveCardTool(orchestrator);
    const okMove = await move.handler({ card_id: 1, column: 'in_progress' }, ctx);
    expect(okMove.isError).toBeFalsy();
    expect(okMove.content).toContain('Card #1 moved to in_progress');

    const blocked = await move.handler({ card_id: 2, column: 'in_progress' }, ctx);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('blocked by cards: 1');
    expect(blocked.content).toContain('kanban_remove_dependency');
  });
});
