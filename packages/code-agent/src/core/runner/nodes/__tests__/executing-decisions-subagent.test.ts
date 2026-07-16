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
    vi.stubEnv('CODER_MAX_AUTO_CONTINUES', '1');
    const ctx = context(50, 50, false);
    expect(decideTerminal(ctx).kind).toBe('TurnSucceeded');
    expect(ctx.autoContinues).toBe(1);
    vi.unstubAllEnvs();
  });
});
