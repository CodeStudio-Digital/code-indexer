/**
 * Fix B — loop-aware compaction trigger tests.
 *
 * Pins: the estimate-sized path (compaction works without provider `usage` —
 * the session-887 regression), the behavioral branches (stuck-progress /
 * cumulative), and the protect-floor that stops a behavioral no-op pass.
 */
import { describe, it, expect } from 'vitest';
import { evaluateLoopAwareCompaction } from '../loop-aware-trigger.js';
import {
  deriveTokenLimits,
  COMPACT_CUMULATIVE_RATIO,
  COMPACT_STUCK_TURN_CAP,
} from '@mcp/code-agent/core/compaction/limits.js';
import { computeProtectTokens } from '../threshold.js';

const MODEL = 'claude-haiku-4-5-20251001';
const limits = deriveTokenLimits(MODEL);
const protect = computeProtectTokens({ model: MODEL });
// Above the protect floor, below the token-budget trigger — isolates the
// behavioral branches from the size branch.
const mid = Math.floor((protect + limits.trigger) / 2);

function base() {
  return { model: MODEL, snapshotTotal: 1000, cumulativeInputTokens: 0, consecutiveNoTextTurns: 0 };
}

describe('evaluateLoopAwareCompaction', () => {
  it('sanity: protect < trigger for the test model', () => {
    expect(protect).toBeLessThan(limits.trigger);
  });

  it('does not compact when small, no loop, no burn', () => {
    const d = evaluateLoopAwareCompaction(base());
    expect(d.shouldCompact).toBe(false);
    expect(d.reason).toBe('none');
  });

  it('token-budget fires from an estimate-sized snapshot (no provider usage needed)', () => {
    // Caller passes the tokenizer estimate as snapshotTotal when usage is
    // absent (ChatGPT backend) — this is the path that never fired for 887.
    const d = evaluateLoopAwareCompaction({ ...base(), snapshotTotal: limits.trigger + 1 });
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('token-budget');
  });

  it('stuck-progress fires after the no-text cap when there is enough to compact', () => {
    const d = evaluateLoopAwareCompaction({
      ...base(),
      snapshotTotal: mid,
      consecutiveNoTextTurns: COMPACT_STUCK_TURN_CAP,
    });
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('stuck-progress');
  });

  it('suppresses a behavioral trigger when nothing sits above the protected tail', () => {
    const d = evaluateLoopAwareCompaction({
      ...base(),
      snapshotTotal: Math.floor(protect / 2),
      consecutiveNoTextTurns: COMPACT_STUCK_TURN_CAP,
    });
    expect(d.shouldCompact).toBe(false);
    expect(d.reason).toBe('none');
  });

  it('cumulative fires on steady burn past ratio × effective', () => {
    const d = evaluateLoopAwareCompaction({
      ...base(),
      snapshotTotal: mid,
      cumulativeInputTokens: COMPACT_CUMULATIVE_RATIO * limits.effective + 1,
    });
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('cumulative');
  });

  it('cumulative does NOT fire below the threshold', () => {
    const d = evaluateLoopAwareCompaction({ ...base(), snapshotTotal: mid, cumulativeInputTokens: 1000 });
    expect(d.shouldCompact).toBe(false);
  });
});
