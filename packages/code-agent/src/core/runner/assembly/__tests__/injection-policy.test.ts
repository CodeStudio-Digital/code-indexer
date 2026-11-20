/**
 * Window-scaled injection policy.
 */
import { describe, it, expect } from 'vitest';
import { resolveInjectionPolicy } from '../injection-policy.js';
import { deriveTokenLimits } from '@mcp/code-agent/core/compaction/limits.js';

const BIG_MODEL = 'claude-haiku-4-5-20251001'; // registered window ≫ 64k

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

  it('ignores the retired short-window env threshold', () => {
    process.env.CODER_SHORT_WINDOW_TOKENS = '99999999';
    const short = resolveInjectionPolicy(BIG_MODEL);
    delete process.env.CODER_SHORT_WINDOW_TOKENS;
    const standard = resolveInjectionPolicy(BIG_MODEL);
    expect(short).toEqual(standard);
  });

  it('liveStateCovered (agentLoopV2 active-context) omits todos from the block', () => {
    const p = resolveInjectionPolicy(BIG_MODEL, { liveStateCovered: true });
    expect(p.budget.includeLiveState).toBe(false);
  });

  it('follows the session context window, exactly like the compaction gates', () => {
    // A big model run with a smaller configured window must not inject as if
    // it had the full registered window.
    expect(resolveInjectionPolicy(BIG_MODEL, { contextWindow: 60_000 }).mode).toBe('short');
    expect(resolveInjectionPolicy(BIG_MODEL, { contextWindow: 30_000 }).mode).toBe('minimal');
    for (const contextWindow of [30_000, 60_000, 200_000]) {
      const effective = deriveTokenLimits(BIG_MODEL, contextWindow).effective;
      const expected = effective <= 16_000 ? 'minimal' : effective <= 64_000 ? 'short' : 'standard';
      expect(resolveInjectionPolicy(BIG_MODEL, { contextWindow }).mode).toBe(expected);
    }
  });

  it('keeps the registered window when the session sets none', () => {
    expect(resolveInjectionPolicy(BIG_MODEL, { contextWindow: null }).mode).toBe('standard');
    expect(resolveInjectionPolicy(BIG_MODEL, {}).mode).toBe('standard');
  });

});
