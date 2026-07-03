/**
 * Onda 2a (Codex-parity): goal state-transition guidance in the
 * <active-context> block. Contract:
 *   - an `in_progress` goal gets a compact `goal_guidance:` continuation line
 *   - a `complete` goal gets none
 *   - a soft token budget folds into the same line
 *   - todo truncation still keeps the header (goal + guidance) intact
 */
import { describe, it, expect } from 'vitest';
import { buildActiveContextBlock } from '../active-context.js';
import type { TodoItem } from '@mcp/code-agent/tools/task-list-shared.js';

describe('buildActiveContextBlock — goal guidance', () => {
  it('adds continuation guidance for an in_progress goal', () => {
    const block = buildActiveContextBlock({ goal: { text: 'Ship feature X', status: 'in_progress' } });
    expect(block).toContain('goal: Ship feature X (status=in_progress)');
    expect(block).toContain('goal_guidance: keep the FULL objective intact');
    expect(block).not.toContain('Soft token budget');
  });

  it('omits guidance for a complete goal', () => {
    const block = buildActiveContextBlock({ goal: { text: 'done', status: 'complete', completionNote: 'shipped' } });
    expect(block).toContain('status=complete — shipped');
    expect(block).not.toContain('goal_guidance:');
  });

  it('folds the soft token budget into the guidance line', () => {
    const block = buildActiveContextBlock({ goal: { text: 'X', status: 'in_progress', budgetTokens: 50000 } });
    expect(block).toContain('Soft token budget ~50000');
  });

  it('returns null when there is nothing to say', () => {
    expect(buildActiveContextBlock({})).toBeNull();
  });

  it('keeps the goal + guidance header when truncating a long todo list', () => {
    const todos: TodoItem[] = Array.from({ length: 200 }, (_, i) => ({
      id: `t${i}`,
      status: 'pending' as const,
      content: `task number ${i} with some length to blow the cap quickly`,
      activeForm: `doing task ${i}`,
    }));
    const block = buildActiveContextBlock({
      goal: { text: 'Big goal', status: 'in_progress' },
      todos,
      maxChars: 600,
    })!;
    expect(block.length).toBeLessThanOrEqual(600);
    expect(block).toContain('goal: Big goal (status=in_progress)');
    expect(block).toContain('goal_guidance:');
    expect(block).toContain('more truncated');
    expect(block).toContain('</active-context>');
  });
});
