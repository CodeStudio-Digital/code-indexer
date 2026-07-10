/**
 * Tests for Quality v2 helpers in `feedback-builder.ts`:
 *
 *   - `shouldClassifyTurn` — adaptive sampling gate
 *   - `computeOutcome`     — verdict-delta scoring
 *   - `worstVerdictOf`     — helper used by the runner
 *
 * All three are pure functions; no DB, no LLM, no async. We exercise
 * each behavior with focused cases that lock in the contract.
 */
import { describe, expect, it } from 'vitest';
import {
  shouldClassifyTurn,
  computeOutcome,
  scoreOutcome,
  fnv1aSample,
  worstVerdictOf,
} from '../feedback-builder.js';
import type { QualityClassificationRow } from '@mcp/store/quality-classification-store.js';

function row(partial: Partial<QualityClassificationRow>): QualityClassificationRow {
  return {
    id: 1,
    session_id: 1,
    company_session_id: null,
    agent_run_id: null,
    coder_run_id: null,
    parent_run_id: null,
    is_subagent: 0,
    subagent_profile: null,
    message_id: 'turn-1',
    classifier_name: 'off_topic',
    verdict: 'ok',
    system_error: 0,
    confidence: 0.9,
    reason: null,
    provider_id: null,
    model_id: null,
    latency_ms: null,
    cost_usd: null,
    raw_response_json: null,
    created_at: '2026-05-19 01:00:00',
    ...partial,
  };
}

describe('shouldClassifyTurn (Quality v2, A1)', () => {
  it('skips when assistant has no narrative text (pure tool_use turn)', () => {
    const decision = shouldClassifyTurn({
      turn: 10,
      sessionId: 1,
      hasNarrativeText: false,
      lastWorstVerdict: 'flagged',
    });
    expect(decision).toBe(false);
  });

  it('always classifies during the first 5 turns (warmup)', () => {
    for (let turn = 1; turn <= 5; turn++) {
      expect(shouldClassifyTurn({
        turn,
        sessionId: 999,
        hasNarrativeText: true,
        lastWorstVerdict: 'ok',
      })).toBe(true);
    }
  });

  it('classifies after warmup when last turn was warn', () => {
    expect(shouldClassifyTurn({
      turn: 50,
      sessionId: 1,
      hasNarrativeText: true,
      lastWorstVerdict: 'warn',
    })).toBe(true);
  });

  it('classifies after warmup when last turn was flagged', () => {
    expect(shouldClassifyTurn({
      turn: 50,
      sessionId: 1,
      hasNarrativeText: true,
      lastWorstVerdict: 'flagged',
    })).toBe(true);
  });

  it('classifies a deterministic subset of "ok" turns past warmup', () => {
    // Test that the sampling is roughly ~1/3 over many turns.
    let classified = 0;
    for (let turn = 6; turn < 306; turn++) {
      if (shouldClassifyTurn({
        turn,
        sessionId: 42,
        hasNarrativeText: true,
        lastWorstVerdict: 'ok',
      })) {
        classified++;
      }
    }
    // Default sample rate is 1/3 → expect ~100 ± reasonable noise out of 300.
    expect(classified).toBeGreaterThan(60);
    expect(classified).toBeLessThan(140);
  });

  it('is deterministic — same (session, turn) returns the same decision', () => {
    const a = shouldClassifyTurn({
      turn: 100, sessionId: 1, hasNarrativeText: true, lastWorstVerdict: 'ok',
    });
    const b = shouldClassifyTurn({
      turn: 100, sessionId: 1, hasNarrativeText: true, lastWorstVerdict: 'ok',
    });
    expect(a).toBe(b);
  });

  it('respects custom warmupTurns', () => {
    expect(shouldClassifyTurn({
      turn: 8,
      sessionId: 1,
      hasNarrativeText: true,
      lastWorstVerdict: 'ok',
      warmupTurns: 10,
    })).toBe(true);
  });

  it('respects custom sampleRate = 1.0 (always)', () => {
    expect(shouldClassifyTurn({
      turn: 100,
      sessionId: 1,
      hasNarrativeText: true,
      lastWorstVerdict: 'ok',
      sampleRate: 1.0,
    })).toBe(true);
  });

  it('respects custom sampleRate = 0 (never except warmup/pressure)', () => {
    expect(shouldClassifyTurn({
      turn: 100,
      sessionId: 1,
      hasNarrativeText: true,
      lastWorstVerdict: 'ok',
      sampleRate: 0,
    })).toBe(false);
  });

  it('lastWorstVerdict=null treated as "ok" (falls through to sampling)', () => {
    // Same as last-verdict=ok — sampling decides.
    const a = shouldClassifyTurn({
      turn: 100, sessionId: 1, hasNarrativeText: true, lastWorstVerdict: null,
    });
    const b = shouldClassifyTurn({
      turn: 100, sessionId: 1, hasNarrativeText: true, lastWorstVerdict: 'ok',
    });
    expect(a).toBe(b);
  });
});

describe('computeOutcome (Quality v2, C3)', () => {
  it('returns improved when at least one classifier dropped severity', () => {
    expect(computeOutcome(
      [{ classifierName: 'completeness', verdict: 'flagged' }],
      [{ classifierName: 'completeness', verdict: 'ok' }],
    )).toBe('improved');
  });

  it('returns worsened when a classifier rose in severity', () => {
    expect(computeOutcome(
      [{ classifierName: 'off_topic', verdict: 'ok' }],
      [{ classifierName: 'off_topic', verdict: 'flagged' }],
    )).toBe('worsened');
  });

  it('returns unchanged when all paired verdicts are identical', () => {
    expect(computeOutcome(
      [{ classifierName: 'completeness', verdict: 'warn' }],
      [{ classifierName: 'completeness', verdict: 'warn' }],
    )).toBe('unchanged');
  });

  it('mixed signals: one improved + one worsened with equal magnitude → unchanged', () => {
    expect(computeOutcome(
      [
        { classifierName: 'completeness', verdict: 'flagged' },
        { classifierName: 'off_topic',    verdict: 'ok' },
      ],
      [
        { classifierName: 'completeness', verdict: 'ok' },        // -2
        { classifierName: 'off_topic',    verdict: 'flagged' },   // +2
      ],
    )).toBe('unchanged');
  });

  it('mixed signals: one improved (large) + one worsened (small) → improved', () => {
    expect(computeOutcome(
      [
        { classifierName: 'completeness', verdict: 'flagged' },
        { classifierName: 'off_topic',    verdict: 'ok' },
      ],
      [
        { classifierName: 'completeness', verdict: 'ok' },    // -2
        { classifierName: 'off_topic',    verdict: 'warn' },  // +1
      ],
    )).toBe('improved');
  });

  it('verdict=error is treated as missing — does not pollute the delta', () => {
    // error before, ok after → no signal counted (still 0 = unchanged)
    expect(computeOutcome(
      [{ classifierName: 'completeness', verdict: 'error' }],
      [{ classifierName: 'completeness', verdict: 'ok' }],
    )).toBe('unchanged');
  });

  it('classifier present in BEFORE only is ignored (no `after` to compare)', () => {
    expect(computeOutcome(
      [
        { classifierName: 'completeness', verdict: 'flagged' },
        { classifierName: 'policy',       verdict: 'flagged' },
      ],
      [
        // policy missing — completeness is the only comparable pair
        { classifierName: 'completeness', verdict: 'ok' },
      ],
    )).toBe('improved');
  });

  it('classifier present in AFTER only is ignored (no `before` baseline)', () => {
    expect(computeOutcome(
      [{ classifierName: 'completeness', verdict: 'ok' }],
      [
        { classifierName: 'completeness', verdict: 'ok' },
        // new classifier appeared (e.g. enabled mid-session) → ignored
        { classifierName: 'code_quality', verdict: 'flagged' },
      ],
    )).toBe('unchanged');
  });

  it('handles empty arrays — defaults to unchanged', () => {
    expect(computeOutcome([], [])).toBe('unchanged');
  });
});

describe('worstVerdictOf', () => {
  it('returns null for empty input', () => {
    expect(worstVerdictOf([])).toBeNull();
  });

  it('returns flagged as soon as any flagged row exists', () => {
    expect(worstVerdictOf([
      row({ verdict: 'ok' }),
      row({ verdict: 'flagged' }),
      row({ verdict: 'warn' }),
    ])).toBe('flagged');
  });

  it('returns warn when no flagged but at least one warn', () => {
    expect(worstVerdictOf([
      row({ verdict: 'ok' }),
      row({ verdict: 'warn' }),
      row({ verdict: 'ok' }),
    ])).toBe('warn');
  });

  it('returns ok when all rows are ok', () => {
    expect(worstVerdictOf([
      row({ verdict: 'ok' }),
      row({ verdict: 'ok' }),
    ])).toBe('ok');
  });

  it('ignores error rows when nothing else qualifies', () => {
    // Implementation contract: error treated like ok (no pressure).
    expect(worstVerdictOf([
      row({ verdict: 'error' }),
      row({ verdict: 'error' }),
    ])).toBe('ok');
  });
});

describe('scoreOutcome (Quality v2 — measurability)', () => {
  it('reports the direction AND how many pairs were measurable', () => {
    expect(scoreOutcome(
      [{ classifierName: 'completeness', verdict: 'flagged' }],
      [{ classifierName: 'completeness', verdict: 'ok' }],
    )).toEqual({ outcome: 'improved', measurable: 1 });
  });

  it('all-error follow-up → measurable=0 (caller must leave it pending)', () => {
    // This is the core fix: an errored follow-up turn must NOT be scored as
    // a real "unchanged" — measurable=0 signals "we could not tell yet".
    expect(scoreOutcome(
      [{ classifierName: 'completeness', verdict: 'flagged' }],
      [{ classifierName: 'completeness', verdict: 'error' }],
    )).toEqual({ outcome: 'unchanged', measurable: 0 });
  });

  it('counts only non-error pairs toward measurable', () => {
    const s = scoreOutcome(
      [
        { classifierName: 'completeness', verdict: 'flagged' },
        { classifierName: 'off_topic',    verdict: 'warn' },
      ],
      [
        { classifierName: 'completeness', verdict: 'ok' },     // measurable, -2
        { classifierName: 'off_topic',    verdict: 'error' },  // not measurable
      ],
    );
    expect(s).toEqual({ outcome: 'improved', measurable: 1 });
  });

  it('empty inputs → unchanged with measurable 0', () => {
    expect(scoreOutcome([], [])).toEqual({ outcome: 'unchanged', measurable: 0 });
  });
});

describe('fnv1aSample', () => {
  it('is deterministic for the same inputs', () => {
    expect(fnv1aSample(7, 42)).toBe(fnv1aSample(7, 42));
    expect(fnv1aSample(7, 42, 'nudge_holdout')).toBe(fnv1aSample(7, 42, 'nudge_holdout'));
  });

  it('always returns a fraction in [0, 1)', () => {
    for (let t = 1; t <= 50; t++) {
      const v = fnv1aSample(123, t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('the salt yields a decorrelated stream (holdout vs sampling)', () => {
    let differ = 0;
    for (let t = 1; t <= 50; t++) {
      if (fnv1aSample(1, t) !== fnv1aSample(1, t, 'nudge_holdout')) differ++;
    }
    expect(differ).toBeGreaterThan(45); // essentially all values change
  });

  it('held-out selection is ~rate over many turns (deterministic)', () => {
    let held = 0;
    for (let t = 1; t <= 1000; t++) {
      if (fnv1aSample(99, t, 'nudge_holdout') < 0.15) held++;
    }
    expect(held).toBeGreaterThan(90);  // ~150 ± noise
    expect(held).toBeLessThan(210);
  });
});
