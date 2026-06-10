/**
 * `applyAgentStatus` must materialise a subordinate the first time its
 * `agent_status` arrives — the spawn signal fires BEFORE any `agent_event`
 * — and carry the `coderSessionId` so the agent's row is clickable. Status
 * events for an existing agent merge in place without losing a
 * previously-known `coderSessionId` or its text/tools.
 */
import { describe, it, expect } from 'vitest';
import { applyAgentStatus, type AgentStatusPayload } from '../agentStatusEvent.js';
import { INITIAL_STREAM_STATE, type AgentStreamState, type StreamState } from '../../types.js';

function base(): StreamState {
  return { ...INITIAL_STREAM_STATE, subordinateStates: new Map() };
}

const evt = (over: Partial<AgentStatusPayload> = {}): AgentStatusPayload => ({
  agentRunId: 7,
  role: 'backend',
  status: 'running',
  message: '',
  coderSessionId: 42,
  ...over,
});

describe('applyAgentStatus — subordinate materialisation', () => {
  it('creates an absent subordinate carrying coderSessionId', () => {
    const agent = applyAgentStatus(base(), evt()).subordinateStates.get(7);
    expect(agent?.role).toBe('backend');
    expect(agent?.status).toBe('running');
    expect(agent?.coderSessionId).toBe(42);
  });

  it('merges status into an existing subordinate without clobbering coderSessionId or text', () => {
    const existing: AgentStreamState = {
      role: 'backend',
      agentRunId: 7,
      coderSessionId: 42,
      textChunks: ['hi'],
      toolCalls: [],
      status: 'running',
    };
    const start: StreamState = { ...base(), subordinateStates: new Map([[7, existing]]) };
    // A later event with NO coderSessionId (e.g. from the reconciler) must
    // keep the known id and not wipe accumulated text.
    const agent = applyAgentStatus(
      start,
      evt({ status: 'waiting', message: 'done', coderSessionId: undefined }),
    ).subordinateStates.get(7);
    expect(agent?.status).toBe('waiting');
    expect(agent?.statusMessage).toBe('done');
    expect(agent?.coderSessionId).toBe(42);
    expect(agent?.textChunks).toEqual(['hi']);
  });

  it('creates the master with coderSessionId when absent', () => {
    const s = applyAgentStatus(base(), evt({ role: 'master', agentRunId: 1, coderSessionId: 9 }));
    expect(s.masterState?.coderSessionId).toBe(9);
    expect(s.masterState?.status).toBe('running');
    expect(s.subordinateStates.size).toBe(0);
  });
});
