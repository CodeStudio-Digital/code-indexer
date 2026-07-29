/**
 * KanbanPriority pipeline tests.
 *
 * Invariants verified:
 *   - 'done' cards are dropped from the output
 *   - bug + blocks_others cards rank above docs cards
 *   - blocked cards rank lower than free cards
 *   - role-availability boost lifts cards whose assignees are idle
 *   - urgency for stalled in_progress > 24h
 *   - effort penalty (longer descriptions = lower score)
 */
import { describe, expect, it } from 'vitest';
import {
  createKanbanPriorityPipeline,
  prioritizeKanban,
  type KanbanCardInput,
} from '../index.js';

function makeCard(overrides: Partial<KanbanCardInput> & Pick<KanbanCardInput, 'id'>): KanbanCardInput {
  return {
    title: 'card',
    description: '',
    column: 'todo',
    tag: null,
    ...overrides,
  };
}

describe('KanbanPriorityPipeline', () => {
  it('drops done cards', async () => {
    const pipeline = createKanbanPriorityPipeline();
    const result = await prioritizeKanban(pipeline, {
      queryId: 'q',
      cards: [
        makeCard({ id: '1', column: 'done' }),
        makeCard({ id: '2', column: 'todo' }),
      ],
    });
    expect(result.ordered.find((c) => c.id === '1')).toBeUndefined();
    expect(result.ordered.find((c) => c.id === '2')).toBeDefined();
  });

  it('ranks bug + blocks_others above docs', async () => {
    const pipeline = createKanbanPriorityPipeline();
    const result = await prioritizeKanban(pipeline, {
      queryId: 'q',
      cards: [
        makeCard({ id: '1', tag: 'documentation' }),
        makeCard({ id: '2', tag: 'bug', blocks: ['3', '4'] }),
        makeCard({ id: '3', tag: 'feature' }),
        makeCard({ id: '4', tag: 'feature' }),
      ],
    });
    expect(result.ordered[0].id).toBe('2');
  });

  it('penalizes blocked cards', async () => {
    const pipeline = createKanbanPriorityPipeline();
    const result = await prioritizeKanban(pipeline, {
      queryId: 'q',
      cards: [
        makeCard({ id: '1', tag: 'feature', blockedBy: ['2', '3'] }),
        makeCard({ id: '2', tag: 'feature' }),
      ],
    });
    const idx = (id: string) => result.ordered.findIndex((c) => c.id === id);
    expect(idx('1')).toBeGreaterThan(idx('2'));
  });

  it('boosts cards assigned to idle roles', async () => {
    const pipeline = createKanbanPriorityPipeline();
    const result = await prioritizeKanban(pipeline, {
      queryId: 'q',
      cards: [
        makeCard({ id: '1', tag: 'feature', assignedRoles: ['frontend'] }),
        makeCard({ id: '2', tag: 'feature', assignedRoles: ['backend'] }),
      ],
      idleRoles: ['frontend'],
    });
    expect(result.ordered[0].id).toBe('1');
  });

  it('bumps urgency for in_progress cards stalled > 24h', async () => {
    const pipeline = createKanbanPriorityPipeline();
    const now = Date.now();
    const result = await prioritizeKanban(pipeline, {
      queryId: 'q',
      nowMs: now,
      cards: [
        makeCard({ id: '1', tag: 'feature', column: 'in_progress', columnUpdatedAtMs: now - 48 * 3600_000 }),
        makeCard({ id: '2', tag: 'feature', column: 'in_progress', columnUpdatedAtMs: now - 1 * 3600_000 }),
      ],
    });
    expect(result.ordered[0].id).toBe('1');
  });

  it('penalizes large cards via effort weight', async () => {
    const pipeline = createKanbanPriorityPipeline();
    const result = await prioritizeKanban(pipeline, {
      queryId: 'q',
      cards: [
        makeCard({ id: '1', tag: 'feature', description: 'X'.repeat(800) }),
        makeCard({ id: '2', tag: 'feature', description: 'short' }),
      ],
    });
    expect(result.ordered[0].id).toBe('2');
  });

  it('returns diagnostics with per-signal breakdown', async () => {
    const pipeline = createKanbanPriorityPipeline();
    const result = await prioritizeKanban(pipeline, {
      queryId: 'q',
      cards: [makeCard({ id: '1', tag: 'bug', blocks: ['99'] })],
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].signals.impact).toBe(1.0);
    expect(result.diagnostics[0].signals.blocksOthers).toBeGreaterThan(0);
  });
});
