/**
 * Tests for the singleton-holder plumbing in `global-classifier-runner.ts`.
 *
 * Verifies:
 *   - setGlobalQualityClassificationStore round-trip
 *   - setGlobalQualityResultObserver fires after classify() completes
 *   - observer errors are swallowed (do not break the pipeline)
 *   - clearing the observer with undefined stops further callbacks
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  setGlobalQualityClassifierPipeline,
  setGlobalQualityClassificationStore,
  getGlobalQualityClassificationStore,
  setGlobalQualityResultObserver,
  runGlobalQualityClassifiers,
  QualityClassifierPipeline,
} from '../index.js';
import type { LLMClassifier } from '../llm-classifier.js';
import type { AgentOutputForClassification, ClassificationVerdict, QualityResult } from '../types.js';

class FakeClassifier {
  classifierName = 'off_topic';
  pipelineName = 'quality_off_topic';
  bindingRole = 'classifier';
  constructor(private verdict: ClassificationVerdict) {}
  async classify(): Promise<ClassificationVerdict> { return this.verdict; }
}

function makePipeline(verdict: ClassificationVerdict): QualityClassifierPipeline {
  return new QualityClassifierPipeline({
    classifiers: [new FakeClassifier(verdict) as unknown as LLMClassifier],
  });
}

afterEach(() => {
  // Reset module state between tests so they're isolated.
  setGlobalQualityClassifierPipeline(undefined, false);
  setGlobalQualityClassificationStore(undefined);
  setGlobalQualityResultObserver(undefined);
});

describe('global-classifier-runner', () => {
  it('store setter and getter round-trip', () => {
    const fakeStore = { /* opaque to this test */ } as never;
    setGlobalQualityClassificationStore(fakeStore);
    expect(getGlobalQualityClassificationStore()).toBe(fakeStore);
    setGlobalQualityClassificationStore(undefined);
    expect(getGlobalQualityClassificationStore()).toBeUndefined();
  });

  it('observer fires after a successful classify()', async () => {
    setGlobalQualityClassifierPipeline(
      makePipeline({ classifierName: 'off_topic', verdict: 'flagged', confidence: 0.95, latencyMs: 1 }),
      true,
    );
    let received: { result: QualityResult; output: AgentOutputForClassification } | null = null;
    setGlobalQualityResultObserver((result, output) => { received = { result, output }; });

    await runGlobalQualityClassifiers({ taskText: 't', outputText: 'o', sessionId: 42 });

    expect(received).not.toBeNull();
    expect(received!.output.sessionId).toBe(42);
    expect(received!.result.worstVerdict).toBe('flagged');
  });

  it('does NOT fire observer when pipeline is disabled', async () => {
    setGlobalQualityClassifierPipeline(
      makePipeline({ classifierName: 'off_topic', verdict: 'flagged', confidence: 1, latencyMs: 1 }),
      false, // disabled
    );
    let fires = 0;
    setGlobalQualityResultObserver(() => { fires++; });

    await runGlobalQualityClassifiers({ taskText: 't', outputText: 'o' });
    expect(fires).toBe(0);
  });

  it('swallows observer errors so pipeline keeps working', async () => {
    setGlobalQualityClassifierPipeline(
      makePipeline({ classifierName: 'off_topic', verdict: 'ok', confidence: 0.9, latencyMs: 1 }),
      true,
    );
    setGlobalQualityResultObserver(() => { throw new Error('observer is buggy'); });

    // Should NOT throw despite the observer error.
    const result = await runGlobalQualityClassifiers({ taskText: 't', outputText: 'o' });
    expect(result).not.toBeNull();
    expect(result!.worstVerdict).toBe('ok');
  });

  it('clearing the observer stops further callbacks', async () => {
    setGlobalQualityClassifierPipeline(
      makePipeline({ classifierName: 'off_topic', verdict: 'ok', confidence: 0.9, latencyMs: 1 }),
      true,
    );
    let fires = 0;
    setGlobalQualityResultObserver(() => { fires++; });
    await runGlobalQualityClassifiers({ taskText: 't', outputText: 'o' });
    expect(fires).toBe(1);

    setGlobalQualityResultObserver(undefined);
    await runGlobalQualityClassifiers({ taskText: 't', outputText: 'o' });
    expect(fires).toBe(1); // unchanged
  });
});
