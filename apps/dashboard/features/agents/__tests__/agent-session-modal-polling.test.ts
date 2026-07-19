import { describe, expect, it } from 'vitest';
import { shouldPollAgentSession } from '../AgentSessionModal.js';

describe('AgentSessionModal live polling', () => {
  it.each([
    'active',
    'running',
    'starting',
    'pending',
    'queued',
    'resuming',
    'waiting_plan',
    'waiting_question',
    'waiting_tasks',
  ])('keeps refreshing while the caller status is %s', (status) => {
    expect(shouldPollAgentSession(status)).toBe(true);
  });

  it.each(['idle', 'completed', 'error', 'aborted', 'interrupted', 'cancelled', 'failed']) (
    'stops refreshing while the caller status is %s',
    (status) => {
      expect(shouldPollAgentSession(status)).toBe(false);
    },
  );

  it('uses the fetched coder-session status as authoritative', () => {
    expect(shouldPollAgentSession('running', 'completed')).toBe(false);
    expect(shouldPollAgentSession('completed', 'running')).toBe(true);
  });

  it('normalizes status casing and whitespace', () => {
    expect(shouldPollAgentSession('  RUNNING  ')).toBe(true);
    expect(shouldPollAgentSession('running', '  COMPLETED ')).toBe(false);
  });
});
