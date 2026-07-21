import { describe, expect, it } from 'vitest';
import { createWorkerLogCapturePolicy } from '../worker-log-policy.js';

describe('worker log capture policy', () => {
  it('drops reconstructable message deltas', () => {
    const capture = createWorkerLogCapturePolicy();
    expect(capture('text', { text: 'hello' }, 0)).toBe(false);
    expect(capture('thinking', { text: 'hmm' }, 0)).toBe(false);
  });

  it('samples duplicate progress while preserving changes and semantic events', () => {
    const capture = createWorkerLogCapturePolicy(5_000);
    const progress = { opId: 'op:1', status: 'running', phase: 'streaming' };

    expect(capture('operation_progress', progress, 1_000)).toBe(true);
    expect(capture('operation_progress', progress, 2_000)).toBe(false);
    expect(capture('operation_progress', { ...progress, phase: 'tool' }, 2_100)).toBe(true);
    expect(capture('operation_progress', { ...progress, phase: 'tool' }, 7_100)).toBe(true);
    expect(capture('operation_finished', { ...progress, status: 'completed' }, 7_101)).toBe(true);
  });

  it('samples agent heartbeats but keeps tool-call progress', () => {
    const capture = createWorkerLogCapturePolicy(5_000);
    const heartbeat = {
      groupId: 'g1',
      agentIndex: 0,
      event: 'heartbeat',
      status: 'running',
      phase: 'provider',
    };

    expect(capture('agent_progress', heartbeat, 1_000)).toBe(true);
    expect(capture('agent_progress', { ...heartbeat, elapsedMs: 2_000 }, 2_000)).toBe(false);
    expect(capture('agent_progress', { ...heartbeat, event: 'tool_call' }, 2_100)).toBe(true);
  });
});
