/**
 * Fix A — self_review nudge gate tests.
 *
 * Pins the doom-loop fix from session 887: the nudge must fire only for
 * UNREVIEWED pending changes, hard-stop after a cap, and respect an explicit
 * user "stop reviewing".
 */
import { describe, it, expect } from 'vitest';
import {
  shouldNudgeSelfReview,
  isSelfReviewDecline,
  type SelfReviewSignals,
  type SelfReviewGateState,
} from '../self-review-gate.js';

const OPTS = { maxReviews: 3 };

function signals(over: Partial<SelfReviewSignals> = {}): SelfReviewSignals {
  return {
    pendingFingerprint: '1:1000',
    lastEditAt: 1000,
    lastReviewAt: null,
    totalAutoReviews: 0,
    ...over,
  };
}
function state(over: Partial<SelfReviewGateState> = {}): SelfReviewGateState {
  return { suppressed: false, ...over };
}

describe('shouldNudgeSelfReview', () => {
  it('nudges when there are unreviewed pending changes', () => {
    expect(shouldNudgeSelfReview(signals(), state(), OPTS)).toBe(true);
  });

  it('does not nudge when there is nothing pending', () => {
    expect(shouldNudgeSelfReview(signals({ pendingFingerprint: '' }), state(), OPTS)).toBe(false);
  });

  it('CORE: does not nudge when changes were already reviewed and nothing edited since', () => {
    const s = signals({ lastEditAt: 1000, lastReviewAt: 2000 });
    expect(shouldNudgeSelfReview(s, state(), OPTS)).toBe(false);
  });

  it('nudges again after a NEW edit lands after the last review', () => {
    const s = signals({ lastEditAt: 3000, lastReviewAt: 2000, pendingFingerprint: '2:3000' });
    expect(shouldNudgeSelfReview(s, state({ lastNudgedFingerprint: '1:1000' }), OPTS)).toBe(true);
  });

  it('nudges once per distinct pending state (same fingerprint → no re-nudge)', () => {
    const s = signals({ pendingFingerprint: '1:1000' });
    expect(shouldNudgeSelfReview(s, state({ lastNudgedFingerprint: '1:1000' }), OPTS)).toBe(false);
  });

  it('hard-stops (and latches suppressed) once the auto-review cap is hit', () => {
    const st = state();
    const s = signals({ totalAutoReviews: 3 });
    expect(shouldNudgeSelfReview(s, st, OPTS)).toBe(false);
    expect(st.suppressed).toBe(true);
    // Latched: even a fresh unreviewed signal stays suppressed for the run.
    expect(shouldNudgeSelfReview(signals({ totalAutoReviews: 0 }), st, OPTS)).toBe(false);
  });

  it('maxReviews <= 0 disables the cap', () => {
    const s = signals({ totalAutoReviews: 99 });
    expect(shouldNudgeSelfReview(s, state(), { maxReviews: 0 })).toBe(true);
  });

  it('never nudges once suppressed', () => {
    expect(shouldNudgeSelfReview(signals(), state({ suppressed: true }), OPTS)).toBe(false);
  });
});

describe('isSelfReviewDecline', () => {
  it.each([
    'finalize os regressivos novamente sem self_review', // the session-887 message
    'sem revisão',
    'não rode self_review',
    'nao faca a revisao agora',
    'pare de revisar',
    'chega de review',
    'skip review',
    'stop the review',
    "don't run the review",
  ])('matches decline: %s', (t) => {
    expect(isSelfReviewDecline(t)).toBe(true);
  });

  it.each([
    '',
    'vou rodar o self_review agora',
    'preciso revisar o código antes de entregar',
    'implementar o componente de review do PR',
    'continue normalmente',
  ])('does not match: %s', (t) => {
    expect(isSelfReviewDecline(t)).toBe(false);
  });
});
