import { describe, it, expect } from 'vitest';
import { classifyQaFailure } from '../parsers/error-classifier.js';

describe('classifyQaFailure — sidecar_down', () => {
  it.each([
    'browserType.connect: connect ECONNREFUSED 127.0.0.1:9223',
    'Error: connect ECONNREFUSED ::1:9223',
    'read ECONNRESET',
    'WebSocket closed before connection was established',
    'browserType.connect: Timeout 30000ms exceeded',
    'Target closed',
    'Target page, context or browser has been closed',
    'Browser has been disconnected',
    'Protocol error (Page.navigate): Connection closed',
  ])('classifies %j', (msg) => {
    expect(classifyQaFailure(msg)).toBe('sidecar_down');
  });
});

describe('classifyQaFailure — reporter_unreachable', () => {
  it('detects failures aimed at the test-event endpoint', () => {
    expect(
      classifyQaFailure(
        'fetch failed: POST http://host.docker.internal:7333/api/company/sessions/9/qa/test-event',
      ),
    ).toBe('reporter_unreachable');
  });

  it('detects PLAYWRIGHT_QA_ENDPOINT mentions', () => {
    expect(classifyQaFailure('PLAYWRIGHT_QA_ENDPOINT unreachable: fetch failed')).toBe(
      'reporter_unreachable',
    );
  });

  it('reporter markers win over sidecar markers (ECONNREFUSED at the endpoint)', () => {
    expect(
      classifyQaFailure('reporter POST /qa/test-event failed: ECONNREFUSED 127.0.0.1:7333'),
    ).toBe('reporter_unreachable');
  });
});

describe('classifyQaFailure — ordinary failures stay null', () => {
  it.each([
    'expect(received).toBe(expected) — Expected: "Login" Received: "Loading"',
    'Timeout 5000ms waiting for locator("#submit")',
    'ReferenceError: describe is not defined',
    '',
  ])('returns null for %j', (msg) => {
    expect(classifyQaFailure(msg)).toBeNull();
  });

  it('handles null/undefined input', () => {
    expect(classifyQaFailure(null)).toBeNull();
    expect(classifyQaFailure(undefined)).toBeNull();
  });
});
