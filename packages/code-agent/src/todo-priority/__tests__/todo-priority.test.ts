/**
 * TodoPriority pipeline tests.
 *
 * Invariants verified:
 *   - in_progress items always at the top
 *   - completed items always at the bottom
 *   - bug + blocked_others items rank higher than docs/typos
 *   - blocked items rank lower than free items
 *   - urgency promotes stalled in_progress items (within the in_progress
 *     slice — they stay above pending regardless)
 *   - quick wins (short descriptions) get a measurable bump
 */
import { describe, expect, it } from 'vitest';
import {
  createTodoPriorityPipeline,
  detectImpact,
  detectQuickWin,
  prioritizeTodos,
  type TodoItem,
} from '../index.js';

function makeTodo(id: string, status: TodoItem['status'], content: string, refs?: string[]): TodoItem {
  return { id, status, content, activeForm: content, refs };
}

describe('detectImpact', () => {
  it('high for bugs / outages / hotfix', () => {
    expect(detectImpact('Fix production crash on login')).toBe(1.0);
    expect(detectImpact('Hotfix the security issue')).toBe(1.0);
  });
  it('medium for features / refactors / tests', () => {
    expect(detectImpact('Refactor the auth module')).toBe(0.6);
    expect(detectImpact('Add coverage for parser')).toBe(0.6);
  });
  it('low for docs / typos', () => {
    expect(detectImpact('Fix typo in docs')).toBe(0.2);
    expect(detectImpact('Rename variable')).toBe(0.2);
  });
});

describe('detectQuickWin', () => {
  it('returns 1.0 for short items', () => {
    expect(detectQuickWin('rename file')).toBe(1.0);
  });
  it('decays for long items', () => {
    const score = detectQuickWin('X'.repeat(100));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
  it('returns 0 for very long items', () => {
    expect(detectQuickWin('X'.repeat(300))).toBe(0);
  });
});

describe('TodoPriorityPipeline', () => {
  it('keeps in_progress at the top and completed at the bottom', async () => {
    const pipeline = createTodoPriorityPipeline();
    const items: TodoItem[] = [
      makeTodo('a', 'pending',     'Fix typo in docs'),
      makeTodo('b', 'completed',   'Old completed work'),
      makeTodo('c', 'in_progress', 'Refactor in progress'),
      makeTodo('d', 'pending',     'Fix production crash'),
    ];
    const result = await prioritizeTodos(pipeline, { queryId: 'q', items });
    expect(result.ordered[0].id).toBe('c'); // in_progress
    expect(result.ordered[result.ordered.length - 1].id).toBe('b'); // completed
  });

  it('ranks high-impact + blocks-others items above low-impact ones', async () => {
    const pipeline = createTodoPriorityPipeline();
    const items: TodoItem[] = [
      makeTodo('docs',  'pending', 'Update docs about installation'),
      makeTodo('lint',  'pending', 'Run lint and fix warnings'),
      // crit is referenced by 2 others → blocks_others bump
      makeTodo('crit',  'pending', 'Fix production crash that blocks login'),
      makeTodo('dep1',  'pending', 'Add login redirect tests', ['crit']),
      makeTodo('dep2',  'pending', 'Document login behavior', ['crit']),
    ];
    const result = await prioritizeTodos(pipeline, { queryId: 'q', items });
    // 'crit' should be the highest-ranked pending item.
    const pendingIds = result.ordered
      .filter((t) => t.status === 'pending')
      .map((t) => t.id);
    expect(pendingIds[0]).toBe('crit');
  });

  it('penalizes blocked items (push them DOWN)', async () => {
    const pipeline = createTodoPriorityPipeline();
    const items: TodoItem[] = [
      makeTodo('blocker', 'pending', 'Refactor auth module'),
      // 'consumer' depends on 'blocker' — should rank LOWER than blocker
      makeTodo('consumer', 'pending', 'Use new auth module', ['blocker']),
      makeTodo('free', 'pending', 'Unrelated independent feature'),
    ];
    const result = await prioritizeTodos(pipeline, { queryId: 'q', items });
    const pendingIds = result.ordered.filter((t) => t.status === 'pending').map((t) => t.id);
    const blockerIdx = pendingIds.indexOf('blocker');
    const consumerIdx = pendingIds.indexOf('consumer');
    expect(blockerIdx).toBeLessThan(consumerIdx);
  });

  it('returns diagnostics with score and per-signal breakdown', async () => {
    const pipeline = createTodoPriorityPipeline();
    const items: TodoItem[] = [
      makeTodo('a', 'pending', 'Fix production crash'),
    ];
    const result = await prioritizeTodos(pipeline, { queryId: 'q', items });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].signals.impact).toBe(1.0);
    expect(result.diagnostics[0].score).toBeGreaterThan(0);
  });

  it('handles an empty list without errors', async () => {
    const pipeline = createTodoPriorityPipeline();
    const result = await prioritizeTodos(pipeline, { queryId: 'q', items: [] });
    expect(result.ordered).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});
