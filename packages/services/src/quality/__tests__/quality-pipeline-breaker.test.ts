/**
 * Perf W4 — per-session system-error circuit breaker. Node-pure (stub
 * classifiers, no store/provider/ABI): 5 consecutive all-system-error calls
 * open the breaker for that session (classify() stops calling providers);
 * a healthy verdict resets the streak; sessions are isolated.
 */
import { describe, expect, it } from 'vitest';
import { QualityClassifierPipeline } from '../quality-pipeline.js';
import type { LLMClassifier } from '../llm-classifier.js';
import type { AgentOutputForClassification, ClassificationVerdict } from '../types.js';

function stubClassifier(
  name: string,
  behavior: () => ClassificationVerdict | Promise<ClassificationVerdict>,
): { classifier: LLMClassifier; calls: { n: number } } {
  const calls = { n: 0 };
  const classifier = {
    classifierName: name,
    classify: async () => {
      calls.n += 1;
      return behavior();
    },
  } as unknown as LLMClassifier;
  return { classifier, calls };
}

const failing = (name: string) =>
  stubClassifier(name, () => {
    throw new Error('binding down');
  });

const healthy = (name: string) =>
  stubClassifier(name, () => ({
    classifierName: name,
    verdict: 'ok' as const,
    reason: 'fine',
    latencyMs: 1,
  }));

const output = (sessionId: number): AgentOutputForClassification =>
  ({ sessionId, text: 'agent output' } as unknown as AgentOutputForClassification);

describe('QualityClassifierPipeline — system-error circuit breaker', () => {
  it('opens after 5 consecutive all-system-error calls and stops invoking classifiers', async () => {
    const { classifier, calls } = failing('off_topic');
    const pipeline = new QualityClassifierPipeline({ classifiers: [classifier] });

    for (let i = 0; i < 5; i++) {
      const res = await pipeline.classify(output(7));
      expect(res.verdicts.every((v) => v.systemError)).toBe(true);
    }
    expect(calls.n).toBe(5);

    // Breaker open: no classifier call, benign empty result.
    const skipped = await pipeline.classify(output(7));
    expect(calls.n).toBe(5);
    expect(skipped.verdicts).toEqual([]);
    expect(skipped.worstVerdict).toBe('ok');
  });

  it('a healthy verdict resets the streak', async () => {
    let fail = true;
    const { classifier, calls } = stubClassifier('policy', () => {
      if (fail) throw new Error('timeout');
      return { classifierName: 'policy', verdict: 'ok' as const, reason: 'fine', latencyMs: 1 };
    });
    const pipeline = new QualityClassifierPipeline({ classifiers: [classifier] });

    for (let i = 0; i < 4; i++) await pipeline.classify(output(9)); // streak 4 — still closed
    fail = false;
    await pipeline.classify(output(9)); // healthy → streak clears
    fail = true;
    for (let i = 0; i < 4; i++) await pipeline.classify(output(9)); // 4 again — still closed
    const res = await pipeline.classify(output(9));
    // 4+1+4+1 calls all reached the classifier — the breaker never opened.
    expect(calls.n).toBe(10);
    expect(res.verdicts).toHaveLength(1);
  });

  it('streaks are isolated per session', async () => {
    const { classifier, calls } = failing('completeness');
    const pipeline = new QualityClassifierPipeline({ classifiers: [classifier] });
    for (let i = 0; i < 5; i++) await pipeline.classify(output(1)); // opens for session 1
    await pipeline.classify(output(2)); // session 2 unaffected
    expect(calls.n).toBe(6);
  });
});
