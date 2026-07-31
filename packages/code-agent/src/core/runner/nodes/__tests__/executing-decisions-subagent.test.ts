import { describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../../machine/types.js';
import { decideTerminal } from '../executing-decisions.js';

function context(turn: number, maxTurns: number, isSubagent = true): RunContext {
  return {
    turn,
    autoContinues: 0,
    opts: { isSubagent, maxTurns },
    messages: [],
    emit: vi.fn(),
  } as unknown as RunContext;
}

describe('decideTerminal subagent policy', () => {
  it('lets an unlimited subagent continue past the former turn ceiling', () => {
    const ctx = context(1_000, 0);
    expect(decideTerminal(ctx)).toEqual({ kind: 'TurnSucceeded', hasToolCalls: true });
    expect(ctx.autoContinues).toBe(0);
  });

  it('treats a positive subagent limit as an exact cap without auto-continue', () => {
    const ctx = context(25, 25);
    expect(decideTerminal(ctx)).toEqual({ kind: 'MaxTurnsReached', autoContinueLeft: 0 });
    expect(ctx.stopReason).toBe('max_turns');
    expect(ctx.autoContinues).toBe(0);
  });

  it('keeps parent auto-continue behavior unchanged', () => {
    const ctx = context(50, 50, false);
    ctx.opts.maxAutoContinues = 1;
    expect(decideTerminal(ctx).kind).toBe('TurnSucceeded');
    expect(ctx.autoContinues).toBe(1);
  });

  it('treats plan mode as an exact ceiling without auto-continue', () => {
    const ctx = context(12, 12, false);
    ctx.opts.planMode = true;
    ctx.opts.maxAutoContinues = 3;
    expect(decideTerminal(ctx)).toEqual({ kind: 'MaxTurnsReached', autoContinueLeft: 0 });
    expect(ctx.stopReason).toBe('max_turns');
    expect(ctx.autoContinues).toBe(0);
  });

  it('lets an unlimited top-level session run past the former default ceiling', () => {
    const ctx = context(10_000, 0, false);
    expect(decideTerminal(ctx)).toEqual({
      kind: 'TurnSucceeded',
      hasToolCalls: true,
    });
    expect(ctx.autoContinues).toBe(0);
  });
});
