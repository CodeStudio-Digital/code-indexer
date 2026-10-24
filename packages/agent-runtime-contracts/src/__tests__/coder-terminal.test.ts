import { describe, expect, it } from 'vitest';
import {
  classifyCoderTerminalOutcome,
  normalizeCoderTerminalSignal,
} from '../coder-terminal.js';

describe('Coder terminal outcome contract', () => {
  it.each([
    ['completed', 'completed'],
    ['max_turns', 'interrupted'],
    ['max_tool_calls', 'interrupted'],
    ['ipc_identity_budget', 'interrupted'],
    ['tool_budget', 'interrupted'],
    ['time_budget', 'interrupted'],
    ['aborted', 'cancelled'],
    ['cancelled', 'cancelled'],
    ['error', 'failed'],
    ['recovery_capped', 'failed'],
    ['doom_loop', 'failed'],
    ['compact_failure', 'failed'],
    ['compact_exhausted', 'failed'],
    ['plan_required', 'failed'],
  ] as const)('classifies %s as %s', (reason, classification) => {
    expect(classifyCoderTerminalOutcome({ event: 'done', reason })).toMatchObject({
      classification,
      reason,
    });
  });

  it('fails closed for a newly introduced non-empty reason', () => {
    expect(classifyCoderTerminalOutcome({
      event: 'done',
      reason: 'future_failure_mode',
    })).toMatchObject({
      classification: 'failed',
      event: 'error',
      message: 'future_failure_mode',
    });
  });

  it('treats an explicit error payload as failure even with a completed reason', () => {
    expect(normalizeCoderTerminalSignal('done', {
      reason: 'completed',
      error: 'flush failed',
    })).toEqual({
      event: 'error',
      data: {
        reason: 'completed',
        error: 'flush failed',
        message: 'flush failed',
      },
    });
  });
});
