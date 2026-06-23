/**
 * PR-C: classifier matrix for the per-task retry decision.
 *
 * `classifyError` is consulted by `dispatchWithRetry` after each
 * failed attempt. Transient → retry with backoff (up to maxRetries).
 * Fatal → bail immediately.
 *
 * Conservative defaults: unknown messages classify as transient so a
 * single retry doesn't burn more than ~5s total. Cap protects against
 * runaway loops.
 */
import { describe, expect, it } from 'vitest';
import { classifyError } from '../execute-tasks/task-retry.js';

describe('classifyError — transient errors', () => {
  const transients = [
    'subagent_quality_watchdog: 3 consecutive turns without tool use',
    'subagent_aborted_by_parent_watchdog',
    'request failed with ETIMEDOUT',
    'ECONNRESET',
    'fetch failed: socket hang up',
    'Network error: ENOTFOUND api.example.com',
    'Provider returned 429 Too Many Requests',
    'Rate limit exceeded',
    'Too Many Requests',
    'Internal Server Error 500',
    'HTTP 503 service unavailable',
    'Provider 504 gateway timeout',
    'request timeout after 30000ms',
    'Some completely unknown failure mode',
  ];

  for (const msg of transients) {
    it(`treats "${msg.slice(0, 40)}..." as transient`, () => {
      expect(classifyError(msg)).toBe('transient');
    });
  }
});

describe('classifyError — fatal errors', () => {
  const fatals = [
    'Refused by dedup: tuple-hash detected duplicate call',
    'Tool gate refusal: plan mode active, write tools blocked',
    'HTTP 401 Unauthorized: invalid API key',
    'HTTP 403 Forbidden: account suspended',
    'invalid_request: schema validation failed',
    'Schema validation: extra fields not allowed',
    'execute_tasks: approved execution mode is inline',
    'Out of extra usage — visit claude.ai/settings/usage',
    'out_of_credits',
  ];

  for (const msg of fatals) {
    it(`treats "${msg.slice(0, 40)}..." as fatal`, () => {
      expect(classifyError(msg)).toBe('fatal');
    });
  }
});

describe('classifyError — Error instances + edge cases', () => {
  it('accepts Error instances directly', () => {
    const e = new Error('ETIMEDOUT after 30s');
    expect(classifyError(e)).toBe('transient');
  });

  it('treats undefined/null as transient (unknown)', () => {
    expect(classifyError(undefined)).toBe('transient');
    expect(classifyError(null)).toBe('transient');
  });

  it('case-insensitive matching', () => {
    expect(classifyError('TIMEOUT')).toBe('transient');
    expect(classifyError('TIMEOUT')).toBe('transient');
    expect(classifyError('Plan Mode active')).toBe('fatal');
  });

  it('quota error wins over generic timeout phrasing', () => {
    expect(classifyError('out of extra usage (timeout suspected)')).toBe('fatal');
  });
});
