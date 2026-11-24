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

const AGENT_RUN_ID = '11111111-1111-4111-8111-111111111111';
const CODER_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const MASTER_RUN_ID = '33333333-3333-4333-8333-333333333333';
const MASTER_SESSION_ID = '44444444-4444-4444-8444-444444444444';

function base(): StreamState {
  return { ...INITIAL_STREAM_STATE, subordinateStates: new Map() };
}

const evt = (over: Partial<AgentStatusPayload> = {}): AgentStatusPayload => ({
  agentRunId: AGENT_RUN_ID,
  role: 'backend',
  status: 'running',
  message: '',
  coderSessionId: CODER_SESSION_ID,
  ...over,
});

describe('applyAgentStatus — subordinate materialisation', () => {
  it('creates an absent subordinate carrying coderSessionId', () => {
    const agent = applyAgentStatus(base(), evt()).subordinateStates.get(AGENT_RUN_ID);
    expect(agent?.role).toBe('backend');
    expect(agent?.status).toBe('running');
    expect(agent?.coderSessionId).toBe(CODER_SESSION_ID);
  });

  it('merges status without clobbering coderSessionId, tools or the separate text preview', () => {
    const existing: AgentStreamState = {
      role: 'backend',
      agentRunId: AGENT_RUN_ID,
      coderSessionId: CODER_SESSION_ID,
      toolCalls: [{ id: 'tool-1', name: 'read_file', status: 'done' }],
      status: 'running',
    };
    const start: StreamState = {
      ...base(),
      subordinateStates: new Map([[AGENT_RUN_ID, existing]]),
      agentTextPreviews: new Map([[AGENT_RUN_ID, 'hi']]),
    };
    // A later event with NO coderSessionId (e.g. from the reconciler) must
    // keep the known id and not wipe accumulated text.
    const result = applyAgentStatus(
      start,
      evt({ status: 'waiting', message: 'done', coderSessionId: undefined }),
    );
    const agent = result.subordinateStates.get(AGENT_RUN_ID);
    expect(agent?.status).toBe('waiting');
    expect(agent?.statusMessage).toBe('done');
    expect(agent?.coderSessionId).toBe(CODER_SESSION_ID);
    expect(agent?.toolCalls).toBe(existing.toolCalls);
    expect(result.agentTextPreviews).toBe(start.agentTextPreviews);
  });

  it('creates the master with coderSessionId when absent', () => {
    const s = applyAgentStatus(base(), evt({
      role: 'master',
      agentRunId: MASTER_RUN_ID,
      coderSessionId: MASTER_SESSION_ID,
    }));
    expect(s.masterState?.coderSessionId).toBe(MASTER_SESSION_ID);
    expect(s.masterState?.status).toBe('running');
    expect(s.subordinateStates.size).toBe(0);
  });

  it('opens a replacement Master at the new chat with its own tool history', () => {
    const previous = applyAgentStatus(base(), evt({ role: 'master' }));
    previous.masterState!.toolCalls.push({ id: 'old', name: 'read_file', status: 'done' });
    const next = applyAgentStatus(previous, evt({ role: 'master', agentRunId: MASTER_RUN_ID, coderSessionId: MASTER_SESSION_ID }));
    expect(next.masterState).toMatchObject({ agentRunId: MASTER_RUN_ID, coderSessionId: MASTER_SESSION_ID, toolCalls: [] });
  });

  it('retains App configured/effective model provenance from the live stream', () => {
    const agent = applyAgentStatus(base(), evt({
      configuredProvider: 'openai-chatgpt',
      configuredModel: 'gpt-5.6-sol',
      effectiveProvider: 'openai-chatgpt',
      effectiveModel: 'gpt-5.6-sol',
      dispatchSource: 'app_studio',
      fallbackReason: null,
    })).subordinateStates.get(AGENT_RUN_ID);

    expect(agent).toMatchObject({
      configuredProvider: 'openai-chatgpt',
      configuredModel: 'gpt-5.6-sol',
      effectiveProvider: 'openai-chatgpt',
      effectiveModel: 'gpt-5.6-sol',
      dispatchSource: 'app_studio',
      fallbackReason: null,
    });
  });
});
