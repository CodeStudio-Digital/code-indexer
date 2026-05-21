/**
 * Tests for Wire #4 v2 (aggregated quality alerts).
 *
 * Verifies the aggregation buffer behavior:
 *   - First N flagged verdicts under threshold → silent (no alert)
 *   - Reaching FLUSH_THRESHOLD → flush + cooldown
 *   - Reaching FLUSH_INTERVAL_MS elapsed since first → flush + cooldown
 *   - During cooldown → bucket updates but doesn't flush
 *   - Cooldown elapses → next flagged verdict can flush again
 *   - Multiple classifiers each get their own bucket
 *   - Chat-individual sessions (no companySessionId) → no alerts at all
 *   - off_topic + policy + tool_misuse alert; other classifiers don't
 *   - Idle buckets eventually get trimmed
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeQualityAlertObserver,
  resetQualityAlertBuffer,
  inspectQualityAlertBuckets,
} from '../quality-observer.js';
import type {
  AgentOutputForClassification,
  ClassificationVerdict,
  QualityResult,
} from '@mcp/services/quality/index.js';

function makeVerdict(partial: Partial<ClassificationVerdict>): ClassificationVerdict {
  return {
    classifierName: 'off_topic',
    verdict: 'ok',
    latencyMs: 1,
    ...partial,
  };
}

function makeResult(verdicts: ClassificationVerdict[]): QualityResult {
  return { verdicts, worstVerdict: 'ok', durationMs: 5 };
}

function output(opts: Partial<AgentOutputForClassification> = {}): AgentOutputForClassification {
  return {
    taskText: 'fix the navbar layout',
    outputText: 'Let me explain webpack instead',
    companySessionId: 7,
    agentRunId: 42,
    messageId: 'turn-15',
    ...opts,
  };
}

function flaggedOffTopic(confidence = 0.95, reason = 'pivoted to webpack'): ClassificationVerdict {
  return makeVerdict({ verdict: 'flagged', confidence, reason });
}

interface Posted { sessionId: number; body: string }

function setup(): { posted: Posted[]; tick: (deltaMs: number) => void; now: () => number; install: () => ReturnType<typeof makeQualityAlertObserver> } {
  resetQualityAlertBuffer();
  const posted: Posted[] = [];
  let nowMs = 1_000_000;
  const now = () => nowMs;
  const tick = (deltaMs: number) => { nowMs += deltaMs; };
  const install = () => makeQualityAlertObserver({
    emit: (sessionId, body) => posted.push({ sessionId, body }),
    now,
  });
  return { posted, tick, now, install };
}

afterEach(() => resetQualityAlertBuffer());

describe('Quality alert aggregation buffer (Wire #4 v2)', () => {
  it('does not fire on the first flagged verdict (below threshold)', () => {
    const { posted, install } = setup();
    const observer = install();
    observer(makeResult([flaggedOffTopic()]), output());
    expect(posted).toEqual([]);
    // But the bucket records it.
    const buckets = inspectQualityAlertBuckets();
    expect(buckets.length).toBe(1);
    expect(buckets[0].count).toBe(1);
  });

  it('flushes when count reaches FLUSH_THRESHOLD (default 5)', () => {
    const { posted, install } = setup();
    const observer = install();
    for (let i = 0; i < 5; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${10 + i}` }));
    }
    expect(posted.length).toBe(1);
    expect(posted[0].sessionId).toBe(7);
    expect(posted[0].body).toMatch(/off_topic/);
    expect(posted[0].body).toMatch(/5 flag\(s\)/);
    expect(posted[0].body).toMatch(/run #42/);
  });

  it('cooldown: more flagged after flush do NOT trigger new alerts', () => {
    const { posted, install, tick } = setup();
    const observer = install();
    // Reach threshold → flush
    for (let i = 0; i < 5; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${10 + i}` }));
    }
    expect(posted.length).toBe(1);
    // Fire 10 more flagged verdicts immediately (still inside cooldown)
    tick(1_000); // 1 second later
    for (let i = 0; i < 10; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${20 + i}` }));
    }
    // Still only one alert total — they updated the bucket but didn't flush.
    expect(posted.length).toBe(1);
  });

  it('flush re-enables after cooldown elapses + threshold met again', () => {
    const { posted, install, tick } = setup();
    const observer = install();
    for (let i = 0; i < 5; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${10 + i}` }));
    }
    expect(posted.length).toBe(1);
    // Advance past cooldown (default 30min)
    tick(31 * 60_000);
    // Now another 5 flagged verdicts should flush again.
    for (let i = 0; i < 5; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${50 + i}` }));
    }
    expect(posted.length).toBe(2);
  });

  it('flushes by time when count stays below threshold but interval elapses', () => {
    const { posted, install, tick } = setup();
    const observer = install();
    // Two flagged verdicts (below threshold of 5)
    observer(makeResult([flaggedOffTopic()]), output({ messageId: 'turn-10' }));
    observer(makeResult([flaggedOffTopic()]), output({ messageId: 'turn-12' }));
    expect(posted.length).toBe(0);
    // Advance past flush interval (default 10min)
    tick(11 * 60_000);
    // One more flagged verdict triggers flush by time.
    observer(makeResult([flaggedOffTopic()]), output({ messageId: 'turn-30' }));
    expect(posted.length).toBe(1);
    expect(posted[0].body).toMatch(/3 flag/);
  });

  it('different classifiers get independent buckets', () => {
    const { posted, install } = setup();
    const observer = install();
    // 3 off_topic flagged (below threshold)
    for (let i = 0; i < 3; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${i}` }));
    }
    // 5 policy flagged (HITS threshold for policy bucket)
    for (let i = 0; i < 5; i++) {
      observer(
        makeResult([makeVerdict({ classifierName: 'policy', verdict: 'flagged', confidence: 0.95, reason: 'rm -rf' })]),
        output({ messageId: `turn-${i + 10}` }),
      );
    }
    // Only policy should have flushed; off_topic still below.
    expect(posted.length).toBe(1);
    expect(posted[0].body).toMatch(/policy/);
    expect(posted[0].body).not.toMatch(/off_topic/);
  });

  it('different agent_runs get independent buckets', () => {
    const { posted, install } = setup();
    const observer = install();
    for (let i = 0; i < 5; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ agentRunId: 42, messageId: `turn-${i}` }));
    }
    for (let i = 0; i < 4; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ agentRunId: 99, messageId: `turn-${i}` }));
    }
    // Run #42 hit threshold (5), run #99 stays below (4).
    expect(posted.length).toBe(1);
    expect(posted[0].body).toMatch(/run #42/);
  });

  it('ignores chat-individual sessions (no companySessionId)', () => {
    const { posted, install } = setup();
    const observer = install();
    for (let i = 0; i < 10; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ companySessionId: undefined }));
    }
    expect(posted).toEqual([]);
    expect(inspectQualityAlertBuckets()).toEqual([]);
  });

  it('ignores non-flagged verdicts (warn, ok, error)', () => {
    const { posted, install } = setup();
    const observer = install();
    observer(makeResult([makeVerdict({ verdict: 'warn',    confidence: 0.99 })]), output());
    observer(makeResult([makeVerdict({ verdict: 'ok',      confidence: 0.99 })]), output());
    observer(makeResult([makeVerdict({ verdict: 'error',   confidence: 0.99 })]), output());
    expect(posted).toEqual([]);
    expect(inspectQualityAlertBuckets()).toEqual([]);
  });

  it('ignores classifiers not in ALERTABLE_CLASSIFIERS (completeness, code_quality)', () => {
    const { posted, install } = setup();
    const observer = install();
    for (let i = 0; i < 10; i++) {
      observer(makeResult([makeVerdict({ classifierName: 'completeness', verdict: 'flagged', confidence: 0.99 })]), output());
      observer(makeResult([makeVerdict({ classifierName: 'code_quality', verdict: 'flagged', confidence: 0.99 })]), output());
    }
    expect(posted).toEqual([]);
  });

  it('ignores flagged verdicts below MIN_CONFIDENCE (0.7)', () => {
    const { posted, install } = setup();
    const observer = install();
    for (let i = 0; i < 10; i++) {
      observer(makeResult([flaggedOffTopic(0.5)]), output());
    }
    expect(posted).toEqual([]);
  });

  it('exemplar text includes up to 3 most recent reasons', () => {
    const { posted, install } = setup();
    const observer = install();
    for (let i = 0; i < 5; i++) {
      observer(
        makeResult([flaggedOffTopic(0.95, `drift reason #${i}`)]),
        output({ messageId: `turn-${10 + i}` }),
      );
    }
    expect(posted.length).toBe(1);
    // Most recent 3 are #2, #3, #4 (FIFO trim).
    expect(posted[0].body).toMatch(/drift reason #2/);
    expect(posted[0].body).toMatch(/drift reason #3/);
    expect(posted[0].body).toMatch(/drift reason #4/);
    // #0 and #1 were dropped.
    expect(posted[0].body).not.toMatch(/drift reason #0/);
    expect(posted[0].body).not.toMatch(/drift reason #1/);
  });

  it('flush body includes turn range when multiple turns observed', () => {
    const { posted, install } = setup();
    const observer = install();
    for (let i = 0; i < 5; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${10 + i}` }));
    }
    expect(posted[0].body).toMatch(/between turn 10-14/);
  });

  it('counts continue to accumulate during cooldown for visibility', () => {
    const { install, tick } = setup();
    const observer = install();
    // Trigger flush at 5.
    for (let i = 0; i < 5; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${i}` }));
    }
    tick(1_000);
    // 3 more inside cooldown.
    for (let i = 0; i < 3; i++) {
      observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${5 + i}` }));
    }
    const buckets = inspectQualityAlertBuckets();
    expect(buckets.length).toBe(1);
    // Bucket reset count after flush, so we should see 3 (the new ones).
    expect(buckets[0].count).toBe(3);
    expect(buckets[0].cooldownUntilMs).not.toBeNull();
  });

  it('does not throw when the emitter throws', () => {
    resetQualityAlertBuffer();
    const observer = makeQualityAlertObserver({
      emit: () => { throw new Error('orchestrator missing'); },
      now: () => 1_000_000,
    });
    expect(() => {
      for (let i = 0; i < 6; i++) {
        observer(makeResult([flaggedOffTopic()]), output({ messageId: `turn-${i}` }));
      }
    }).not.toThrow();
  });
});
