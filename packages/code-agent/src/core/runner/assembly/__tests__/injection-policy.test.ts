/**
 * Window-scaled injection policy — thresholds, env knobs, kill switch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveInjectionPolicy } from '../injection-policy.js';

const BIG_MODEL = 'claude-haiku-4-5-20251001'; // registered window ≫ 64k

afterEach(() => {
  delete process.env.CODER_SESSION_STATE;
  delete process.env.CODER_SHORT_WINDOW_TOKENS;
});

describe('resolveInjectionPolicy', () => {
  it('big windows → standard mode, milestone injection', () => {
    const p = resolveInjectionPolicy(BIG_MODEL);
    expect(p.mode).toBe('standard');
    expect(p.enabled).toBe(true);
    expect(p.stateEveryTurn).toBe(false);
    expect(p.memoryIndexChars).toBeGreaterThan(0);
    expect(p.budget.includeLiveState).toBe(true);
  });

  it('unknown model falls back to the default window → standard', () => {
    const p = resolveInjectionPolicy('totally-unknown-model-xyz');
    expect(p.mode).toBe('standard');
  });

  it('short threshold is env-tunable — raising it flips a big model to short', () => {
    process.env.CODER_SHORT_WINDOW_TOKENS = '99999999';
    const short = resolveInjectionPolicy(BIG_MODEL);
    delete process.env.CODER_SHORT_WINDOW_TOKENS;
    const standard = resolveInjectionPolicy(BIG_MODEL);
    expect(short.mode).toBe('short');
    expect(short.stateEveryTurn).toBe(true);
    // Short budget is materially leaner than standard across the board.
    expect(short.budget.planChars).toBeLessThan(standard.budget.planChars);
    expect(short.budget.noteSlots).toBeLessThan(standard.budget.noteSlots);
    expect(short.memoryIndexChars).toBeLessThan(standard.memoryIndexChars);
  });

  it('liveStateCovered (agentLoopV2 active-context) omits goal/todos from the block', () => {
    const p = resolveInjectionPolicy(BIG_MODEL, { liveStateCovered: true });
    expect(p.budget.includeLiveState).toBe(false);
  });

  it('CODER_SESSION_STATE=0 kills the block', () => {
    process.env.CODER_SESSION_STATE = '0';
    const p = resolveInjectionPolicy(BIG_MODEL);
    expect(p.enabled).toBe(false);
  });
});
