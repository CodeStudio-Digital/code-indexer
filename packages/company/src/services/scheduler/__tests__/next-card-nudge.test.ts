/**
 * Tests for the pure next-card nudge gate (C3) — idle master + ready todo
 * cards + zero active subordinates, with idle threshold and cooldown.
 */
import { describe, expect, it } from 'vitest';
import {
  NEXT_CARD_COOLDOWN_MS,
  NEXT_CARD_IDLE_MS,
  countReadyTodoCards,
  evaluateNextCardNudge,
  readNextCardIdleMs,
  type NextCardNudgeInput,
} from '../next-card-nudge.js';

const card = (over: Record<string, unknown> = {}) => ({
  column: 'todo',
  blocked_by: [] as number[],
  agents: [] as Array<{ unassigned_at: string | null }>,
  ...over,
});

describe('countReadyTodoCards', () => {
  it('counts only unblocked, unassigned todo cards', () => {
    expect(
      countReadyTodoCards([
        card(),
        card({ column: 'backlog' }),
        card({ blocked_by: [9] }),
        card({ agents: [{ unassigned_at: null }] }),
        card({ agents: [{ unassigned_at: '2026-07-01' }] }), // unassigned again → ready
      ] as never),
    ).toBe(2);
  });
});

describe('readNextCardIdleMs', () => {
  it('default when absent/blank; 0 disables; floors small values', () => {
    expect(readNextCardIdleMs({} as NodeJS.ProcessEnv)).toBe(NEXT_CARD_IDLE_MS);
    expect(readNextCardIdleMs({ MCP_COMPANY_NEXT_CARD_NUDGE_MS: '' } as never)).toBe(NEXT_CARD_IDLE_MS);
    expect(readNextCardIdleMs({ MCP_COMPANY_NEXT_CARD_NUDGE_MS: '0' } as never)).toBe(0);
    expect(readNextCardIdleMs({ MCP_COMPANY_NEXT_CARD_NUDGE_MS: '10' } as never)).toBe(5_000);
    expect(readNextCardIdleMs({ MCP_COMPANY_NEXT_CARD_NUDGE_MS: '60000' } as never)).toBe(60_000);
    expect(readNextCardIdleMs({ MCP_COMPANY_NEXT_CARD_NUDGE_MS: 'nope' } as never)).toBe(NEXT_CARD_IDLE_MS);
  });
});

describe('evaluateNextCardNudge', () => {
  const NOW = 1_700_000_000_000;
  const ready: NextCardNudgeInput = {
    masterAlive: true,
    masterIdleMs: NEXT_CARD_IDLE_MS + 1,
    activeSubordinateCount: 0,
    readyTodoCount: 3,
    nowMs: NOW,
    lastNudgeAtMs: 0,
    idleThresholdMs: NEXT_CARD_IDLE_MS,
  };

  it('nudges when every condition holds, with the card count in the message', () => {
    const decision = evaluateNextCardNudge(ready);
    expect(decision.nudge).toBe(true);
    if (!decision.nudge) return;
    expect(decision.readyCount).toBe(3);
    expect(decision.message).toContain('3 ready card(s)');
    expect(decision.message).toContain('kanban_plan_graph');
  });

  it.each<[string, Partial<NextCardNudgeInput>]>([
    ['dead master', { masterAlive: false }],
    ['active subordinates', { activeSubordinateCount: 1 }],
    ['no ready cards', { readyTodoCount: 0 }],
    ['master not idle long enough', { masterIdleMs: NEXT_CARD_IDLE_MS - 1 }],
    ['unknown idle age (NaN)', { masterIdleMs: Number.NaN }],
    ['disabled via threshold 0', { idleThresholdMs: 0 }],
    ['inside the cooldown', { lastNudgeAtMs: NOW - NEXT_CARD_COOLDOWN_MS + 1 }],
  ])('does NOT nudge with %s', (_label, over) => {
    expect(evaluateNextCardNudge({ ...ready, ...over }).nudge).toBe(false);
  });

  it('nudges again once the cooldown elapsed', () => {
    expect(
      evaluateNextCardNudge({ ...ready, lastNudgeAtMs: NOW - NEXT_CARD_COOLDOWN_MS }).nudge,
    ).toBe(true);
  });
});
