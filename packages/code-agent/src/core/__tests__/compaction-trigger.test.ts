/**
 * Tests for `computeCompactionTrigger` — the Phase D multidimensional
 * compaction trigger. Replaces the inline `snap.total >= trigger` check
 * in the runner with a pure helper that also covers cumulative spend,
 * polling-loop tendency, and stuck-progress.
 *
 * Session 763's pattern (`list_subordinates` polled 273× with each
 * single turn staying under the 206k token trigger but 535 turns
 * burning 58M cumulative) was the motivating real-world case:
 * primary token-budget didn't fire because each turn fit, but
 * cumulative + polling-loop should have.
 */
import { describe, it, expect } from 'vitest';
import {
  computeCompactionTrigger,
  type CompactionTriggerInputs,
} from '../compaction.js';

// Sensible baseline mirroring the runner's defaults for a 272k-window
// model (`gpt-5.5` in the registry).
const baseInputs: CompactionTriggerInputs = {
  snapshotTotal: null,
  trigger: null,
  effective: null,
  charTotal: 0,
  charMinimum: 60_000,
  legacyTriggerTokens: null,
  lastKnownInputTokens: null,
  cumulativeInputTokens: 0,
  pollingLoopDetected: false,
  consecutiveNoTextTurns: 0,
  cumulativeRatio: 10,
  pollingTriggerRatio: 0.5,
  stuckTurnCap: 8,
};

const tokenMode = (overrides: Partial<CompactionTriggerInputs> = {}): CompactionTriggerInputs => ({
  ...baseInputs,
  snapshotTotal: 0,
  trigger: 206_000,
  effective: 256_000,
  ...overrides,
});

describe('computeCompactionTrigger — token-budget primary path', () => {
  it('does NOT fire when snapshot is well below trigger', () => {
    const d = computeCompactionTrigger(tokenMode({ snapshotTotal: 50_000 }));
    expect(d.shouldCompact).toBe(false);
    expect(d.reason).toBe('none');
  });

  it('fires at exactly trigger', () => {
    const d = computeCompactionTrigger(tokenMode({ snapshotTotal: 206_000 }));
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('token-budget');
    expect(d.detail).toContain('tokens=206000');
  });

  it('fires when snapshot exceeds trigger', () => {
    const d = computeCompactionTrigger(tokenMode({ snapshotTotal: 220_000 }));
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('token-budget');
  });
});

describe('computeCompactionTrigger — cumulative trigger (session 763 case)', () => {
  it('fires when cumulative exceeds N×effective even though per-turn is below trigger', () => {
    // Session 763: each per-turn was ~200k (below 206k trigger), but
    // 535 turns × ~109k avg = 58M cumulative >> 256k × 10 = 2.56M.
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 198_000,        // below trigger 206_000
      cumulativeInputTokens: 58_400_000,
      cumulativeRatio: 10,
    }));
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('cumulative');
    expect(d.detail).toContain('58400000');
    expect(d.detail).toContain('10× effective');
  });

  it('does NOT fire when cumulative is below N×effective', () => {
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 50_000,
      cumulativeInputTokens: 1_000_000,  // 1M < 256k×10=2.56M
    }));
    expect(d.shouldCompact).toBe(false);
  });

  it('uses tokenized estimate of charMinimum when only legacy info present', () => {
    // No model id — fall back to charMinimum/4 as the effective estimate.
    // charMinimum=60k → tokens≈15k → cumulative threshold = (15k+50k)×10 = 650k
    const d = computeCompactionTrigger({
      ...baseInputs,
      cumulativeInputTokens: 800_000,
      charTotal: 30_000,  // under charMinimum
      cumulativeRatio: 10,
    });
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('cumulative');
  });
});

describe('computeCompactionTrigger — polling-loop tendency', () => {
  it('fires at half the trigger when polling loop is detected', () => {
    // Halved trigger = 103_000. Snapshot 120_000 is well above.
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 120_000,
      pollingLoopDetected: true,
      pollingTriggerRatio: 0.5,
    }));
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('polling-loop');
    expect(d.detail).toContain('lowered from 206000');
  });

  it('still respects the lowered threshold (does not fire below it)', () => {
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 50_000,           // below the 103_000 lowered trigger
      pollingLoopDetected: true,
      pollingTriggerRatio: 0.5,
    }));
    expect(d.shouldCompact).toBe(false);
  });

  it('does NOT use the lowered threshold when no polling loop detected', () => {
    // 120k is below the normal 206k trigger and no loop detected → no compact
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 120_000,
      pollingLoopDetected: false,
    }));
    expect(d.shouldCompact).toBe(false);
  });

  it('polling ratio 1.0 is equivalent to no lowering (operator escape)', () => {
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 150_000,        // below 206k normal
      pollingLoopDetected: true,
      pollingTriggerRatio: 1.0,
    }));
    expect(d.shouldCompact).toBe(false);  // 150k < 206k×1.0
  });
});

describe('computeCompactionTrigger — stuck-progress', () => {
  it('fires when consecutiveNoTextTurns reaches the cap', () => {
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 5_000,            // tiny — would never trip token budget
      consecutiveNoTextTurns: 8,
      stuckTurnCap: 8,
    }));
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('stuck-progress');
    expect(d.detail).toContain('8 consecutive turns');
  });

  it('does NOT fire just below the cap', () => {
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 5_000,
      consecutiveNoTextTurns: 7,
      stuckTurnCap: 8,
    }));
    expect(d.shouldCompact).toBe(false);
  });

  it('works independently of token tracking (legacy mode too)', () => {
    const d = computeCompactionTrigger({
      ...baseInputs,
      consecutiveNoTextTurns: 10,
      stuckTurnCap: 8,
      charTotal: 1_000,
    });
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('stuck-progress');
  });
});

describe('computeCompactionTrigger — legacy char-budget fallback', () => {
  it('fires on char count when no token snapshot available', () => {
    const d = computeCompactionTrigger({
      ...baseInputs,
      charTotal: 100_000,         // above 60_000 minimum
    });
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('char-budget');
    expect(d.detail).toContain('chars=100000');
  });

  it('prefers legacy token budget when lastKnownInputTokens is set', () => {
    const d = computeCompactionTrigger({
      ...baseInputs,
      charTotal: 50_000,            // below char minimum
      legacyTriggerTokens: 200_000,
      lastKnownInputTokens: 220_000,
    });
    expect(d.shouldCompact).toBe(true);
    expect(d.reason).toBe('char-budget');
    expect(d.detail).toContain('legacy tokens=220000');
  });

  it('does NOT fire when both char and legacy token are below thresholds', () => {
    const d = computeCompactionTrigger({
      ...baseInputs,
      charTotal: 30_000,
      legacyTriggerTokens: 200_000,
      lastKnownInputTokens: 50_000,
    });
    expect(d.shouldCompact).toBe(false);
  });
});

describe('computeCompactionTrigger — priority ordering', () => {
  it('polling-loop fires before token-budget when both would trigger', () => {
    // Loop detected + snapshot well above normal trigger
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 300_000,
      pollingLoopDetected: true,
    }));
    expect(d.reason).toBe('polling-loop');
  });

  it('stuck-progress fires before cumulative when both would trigger', () => {
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 10_000,
      consecutiveNoTextTurns: 10,
      cumulativeInputTokens: 5_000_000,
    }));
    expect(d.reason).toBe('stuck-progress');
  });

  it('cumulative fires before token-budget when both would trigger', () => {
    // cumulative exceeds threshold AND snapshot exceeds trigger
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 250_000,
      cumulativeInputTokens: 10_000_000,
    }));
    expect(d.reason).toBe('cumulative');
  });
});

describe('computeCompactionTrigger — no-trigger sanity', () => {
  it('returns shouldCompact=false with reason="none" when nothing fires', () => {
    const d = computeCompactionTrigger(tokenMode({
      snapshotTotal: 50_000,
      cumulativeInputTokens: 100_000,
      consecutiveNoTextTurns: 2,
      pollingLoopDetected: false,
    }));
    expect(d.shouldCompact).toBe(false);
    expect(d.reason).toBe('none');
    expect(d.detail).toBe('');
  });

  it('handles all-zero inputs without crashing', () => {
    const d = computeCompactionTrigger({
      ...baseInputs,
      cumulativeRatio: 0,         // edge: disabled cumulative
      stuckTurnCap: 0,
    });
    expect(d.shouldCompact).toBe(false);
  });
});
