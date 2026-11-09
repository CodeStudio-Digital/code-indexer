/**
 * Per-agent live activity pill — `applyAgentEvent` must derive an `activity`
 * block (the same shape the chat pill renders) from `provider_call` / tool /
 * `tool_progress` / `operation_*` events, keyed by agent (master or
 * subordinate by agentRunId), and clear it on terminal events.
 */
import { describe, it, expect } from 'vitest';
import { applyAgentEvent, type AgentEventEnvelope } from '../agentEvent.js';
import { INITIAL_STREAM_STATE } from '../../types.js';
import type { StreamState } from '../../types.js';

function base(): StreamState {
  return { ...INITIAL_STREAM_STATE, subordinateStates: new Map() };
}

function send(state: StreamState, ae: AgentEventEnvelope): StreamState {
  return applyAgentEvent(state, ae);
}

const SUB_RUN_ID = '11111111-1111-4111-8111-111111111111';
const MASTER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const SUB = { agent: 'backend', agentRunId: SUB_RUN_ID } as const;

describe('applyAgentEvent — live activity per agent', () => {
  it('provider_call populates a running provider activity for a subordinate', () => {
    const s = send(base(), {
      ...SUB,
      event: 'provider_call',
      data: { runId: 'r1', turn: 0, provider: 'zai', model: 'glm-5.1', toolCount: 51 },
    });
    const act = s.subordinateStates.get(SUB_RUN_ID)?.activity;
    expect(act?.status).toBe('running');
    expect(act?.kind).toBe('provider');
    expect(act?.label).toBe('zai:glm-5.1');
    expect(act?.note).toBe('calling provider with 51 tools');
  });

  it('works for the master too (agent==="master")', () => {
    const s = send(base(), {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
      event: 'provider_call',
      data: { provider: 'anthropic', model: 'opus' },
    });
    expect(s.masterState?.activity?.label).toBe('anthropic:opus');
    expect(s.masterState?.activity?.status).toBe('running');
  });

  it('tool_call_start shows the tool as the current activity, result completes it', () => {
    let s = send(base(), { ...SUB, event: 'tool_call_start', data: { id: 't1', name: 'read_file' } });
    expect(s.subordinateStates.get(SUB_RUN_ID)?.activity?.kind).toBe('tool');
    expect(s.subordinateStates.get(SUB_RUN_ID)?.activity?.label).toBe('read_file');
    expect(s.subordinateStates.get(SUB_RUN_ID)?.activity?.status).toBe('running');

    s = send(s, { ...SUB, event: 'tool_call_result', data: { id: 't1', duration_ms: 1200, status: 'done' } });
    expect(s.subordinateStates.get(SUB_RUN_ID)?.activity?.status).toBe('completed');
  });

  it('clears the activity on message_complete and on done', () => {
    let s = send(base(), {
      ...SUB,
      event: 'provider_call',
      data: { provider: 'zai', model: 'glm-5.1' },
    });
    expect(s.subordinateStates.get(SUB_RUN_ID)?.activity).toBeTruthy();

    s = send(s, { ...SUB, event: 'message_complete', data: {} });
    expect(s.subordinateStates.get(SUB_RUN_ID)?.activity ?? null).toBeNull();

    s = send(s, { ...SUB, event: 'provider_call', data: { provider: 'zai', model: 'glm-5.1' } });
    expect(s.subordinateStates.get(SUB_RUN_ID)?.activity).toBeTruthy();
    s = send(s, { ...SUB, event: 'done', data: { reason: 'completed' } });
    expect(s.subordinateStates.get(SUB_RUN_ID)?.activity ?? null).toBeNull();
  });

  it('latest action supersedes the previous one (provider → tool)', () => {
    let s = send(base(), { ...SUB, event: 'provider_call', data: { provider: 'zai', model: 'glm-5.1' } });
    s = send(s, { ...SUB, event: 'tool_call_start', data: { id: 't9', name: 'write_file' } });
    expect(s.subordinateStates.get(SUB_RUN_ID)?.activity?.label).toBe('write_file');
  });
});
