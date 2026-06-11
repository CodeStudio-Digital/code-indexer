import { describe, expect, it } from 'vitest';
import {
  COOLDOWN_MS,
  FRESH_MS,
  MAX_ATTEMPTS,
  decideAutoFix,
  type AutoFixPolicyInput,
  type AutoFixProblem,
} from '../autofix-policy.js';

const NOW = 1_000_000;

function problem(over: Partial<AutoFixProblem> = {}): AutoFixProblem {
  return { signature: 'err|boom', kind: 'runtime', ts: NOW - 1_000, ...over };
}

/** Idle, cooldown long expired, watermark at zero — the permissive baseline. */
function input(over: Partial<AutoFixPolicyInput<AutoFixProblem>> = {}): AutoFixPolicyInput<AutoFixProblem> {
  return {
    problems: [],
    attempts: new Map(),
    busyNow: false,
    prevBusy: false,
    suspectBefore: 0,
    lastFireAt: NOW - COOLDOWN_MS - 1,
    now: NOW,
    ...over,
  };
}

describe('decideAutoFix', () => {
  it('skips while busy even with a fresh eligible candidate', () => {
    const d = decideAutoFix(input({ busyNow: true, problems: [problem()] }));
    expect(d).toEqual({ kind: 'skip' });
  });

  it('fires the newest eligible candidate when idle and cooled down', () => {
    const older = problem({ signature: 'err|a', ts: NOW - 5_000 });
    const newer = problem({ signature: 'err|b', ts: NOW - 1_000 });
    const d = decideAutoFix(input({ problems: [older, newer] }));
    expect(d).toEqual({ kind: 'fire', target: newer });
  });

  it('skips when the global cooldown has not elapsed', () => {
    const d = decideAutoFix(input({ problems: [problem()], lastFireAt: NOW - COOLDOWN_MS + 1 }));
    expect(d).toEqual({ kind: 'skip' });
  });

  it('skips an exhausted signature and picks the next eligible one', () => {
    const exhausted = problem({ signature: 'err|dead', ts: NOW - 500 });
    const eligible = problem({ signature: 'err|alive', ts: NOW - 2_000 });
    const d = decideAutoFix(input({
      problems: [eligible, exhausted],
      attempts: new Map([['err|dead', MAX_ATTEMPTS]]),
    }));
    expect(d).toEqual({ kind: 'fire', target: eligible });
  });

  it('never fires console problems', () => {
    const d = decideAutoFix(input({ problems: [problem({ kind: 'console' })] }));
    expect(d).toEqual({ kind: 'skip' });
  });

  it('does not fire stale problems (older than FRESH_MS)', () => {
    const d = decideAutoFix(input({ problems: [problem({ ts: NOW - FRESH_MS - 1 })] }));
    expect(d).toEqual({ kind: 'skip' });
  });

  // The regression test for this bug: errors captured during a run are
  // suspect — even if HMR re-stamped them seconds before the run ended,
  // they must not fire until they re-emit past the run-end watermark.
  it('does not fire problems at or before the suspect watermark, even fresh ones', () => {
    const mark = NOW - 2_000;
    const d = decideAutoFix(input({
      problems: [problem({ ts: mark }), problem({ signature: 'err|other', ts: mark - 1 })],
      suspectBefore: mark,
    }));
    expect(d).toEqual({ kind: 'skip' });
  });

  describe('busy→idle edge', () => {
    it('requests revalidation when a candidate was emitted during the run', () => {
      const d = decideAutoFix(input({
        prevBusy: true,
        problems: [problem({ ts: NOW - 30_000 })],
        suspectBefore: NOW - 60_000,
      }));
      expect(d).toEqual({ kind: 'edge', revalidate: true });
    });

    it('does not revalidate for entries from before the previous watermark', () => {
      const d = decideAutoFix(input({
        prevBusy: true,
        problems: [problem({ ts: NOW - 60_000 })],
        suspectBefore: NOW - 30_000,
      }));
      expect(d).toEqual({ kind: 'edge', revalidate: false });
    });

    it('does not revalidate for console-only or exhausted problems', () => {
      const d = decideAutoFix(input({
        prevBusy: true,
        problems: [
          problem({ kind: 'console', ts: NOW - 1_000 }),
          problem({ signature: 'err|dead', ts: NOW - 1_000 }),
        ],
        attempts: new Map([['err|dead', MAX_ATTEMPTS]]),
        suspectBefore: NOW - 30_000,
      }));
      expect(d).toEqual({ kind: 'edge', revalidate: false });
    });

    it('wins over the fire path on the same tick', () => {
      // Even with a fireable candidate, the edge must be handled first —
      // the caller advances the watermark before anything may fire.
      const d = decideAutoFix(input({ prevBusy: true, problems: [problem()] }));
      expect(d.kind).toBe('edge');
    });
  });

  it('full cycle: mid-run error → revalidate → re-emission fires once → fixed run stays silent', () => {
    const attempts = new Map<string, number>();
    let suspectBefore = 0;
    let lastFireAt = 0;
    let now = NOW;
    const sig = 'err|active is not defined';

    // Mid-run: error captured while busy → nothing happens.
    const midRun = problem({ signature: sig, ts: now - 4_000 });
    expect(decideAutoFix(input({
      problems: [midRun], attempts, busyNow: true, suspectBefore, lastFireAt, now,
    }))).toEqual({ kind: 'skip' });

    // Run ends: edge → revalidate (the entry is post-watermark = suspect).
    now += 2_000;
    const edge = decideAutoFix(input({
      problems: [midRun], attempts, prevBusy: true, suspectBefore, lastFireAt, now,
    }));
    expect(edge).toEqual({ kind: 'edge', revalidate: true });
    suspectBefore = now; // caller advances the watermark + reloads preview

    // Stale entry alone never fires after the watermark…
    now += 2_000;
    expect(decideAutoFix(input({
      problems: [midRun], attempts, suspectBefore, lastFireAt, now,
    }))).toEqual({ kind: 'skip' });

    // …but the post-reload re-emission does, exactly once.
    now += 2_000;
    const reEmitted = problem({ signature: sig, ts: now - 500 });
    const fire = decideAutoFix(input({
      problems: [reEmitted], attempts, suspectBefore, lastFireAt, now,
    }));
    expect(fire).toEqual({ kind: 'fire', target: reEmitted });
    attempts.set(sig, 1); // caller bookkeeping
    lastFireAt = now;

    // The fix run ends. The fired entry is still newer than the previous
    // watermark, so the edge revalidates once more — confirming the fix
    // with a reload. The fixed error does not re-emit…
    now += 60_000;
    const edge2 = decideAutoFix(input({
      problems: [reEmitted], attempts, prevBusy: true, suspectBefore, lastFireAt, now,
    }));
    expect(edge2).toEqual({ kind: 'edge', revalidate: true });
    suspectBefore = now;

    // …so nothing ever fires again…
    now += 10_000;
    expect(decideAutoFix(input({
      problems: [reEmitted], attempts, suspectBefore, lastFireAt, now,
    }))).toEqual({ kind: 'skip' });

    // …and later runs stop reloading too: the leftover entry is now behind
    // the watermark, so further edges are quiet (no reload churn).
    now += 60_000;
    expect(decideAutoFix(input({
      problems: [reEmitted], attempts, prevBusy: true, suspectBefore, lastFireAt, now,
    }))).toEqual({ kind: 'edge', revalidate: false });
  });
});
