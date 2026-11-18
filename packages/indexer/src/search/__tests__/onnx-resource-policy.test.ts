import { expect, it } from 'vitest';
import { onnxSessionOptions } from '../onnx-resource-policy.js';
import { backgroundInferenceDutyCycle } from '../background-inference-budget.js';

it.each([1, 2, 4, 8, 32, 128])('bounds native embedding/reranker thread pools on %i cores', cores => {
  expect(onnxSessionOptions(cores)).toEqual({
    intraOpNumThreads: cores < 4 ? 1 : 2,
    interOpNumThreads: 1,
    executionMode: 'sequential',
  });
});

it('reduces background work under CPU or event-loop pressure and recovers after it subsides', () => {
  expect(backgroundInferenceDutyCycle(0.1, 0.1)).toBe(0.5);
  expect(backgroundInferenceDutyCycle(0.8, 0.1)).toBe(0.1);
  expect(backgroundInferenceDutyCycle(0.1, 0.9)).toBe(0.1);
  expect(backgroundInferenceDutyCycle(0.1, 0.1)).toBe(0.5);
});
