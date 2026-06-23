import { describe, it, expect } from 'vitest';
import { applyAgentEvent } from '@apps/dashboard/state/company/stream-handlers/agentEvent.js';
import { applyBoardEntry } from '@apps/dashboard/state/company/stream-handlers/boardEvent.js';
import {
  applyMasterPrompt,
  hydrateMasterPrompts,
} from '@apps/dashboard/state/company/stream-handlers/masterPromptEvent.js';
import {
  applyAgentStatus,
  applySessionIdle,
  applySubordinateWaitingStatus,
} from '@apps/dashboard/state/company/stream-handlers/agentStatusEvent.js';
import {
  INITIAL_STREAM_STATE,
  type StreamState,
} from '@apps/dashboard/state/company/types.js';
import type { MasterPrompt } from '@mcp/company-contracts';

function blank(): StreamState {
  return { ...INITIAL_STREAM_STATE, subordinateStates: new Map(), masterPrompts: new Map(), boardMessages: [], fallbackNotices: [] };
}

function prompt(overrides: Partial<MasterPrompt> = {}): MasterPrompt {
  return {
    id: 1,
    company_session_id: 42,
    agent_run_id: null,
    kind: 'question',
    runner_block_id: null,
    body: 'q?',
    options: null,
    allow_freeform: true,
    status: 'pending',
    answer: null,
    approved: null,
    feedback: null,
    created_at: '2025-01-01',
    resolved_at: null,
    ...overrides,
  };
}

describe('stream-handlers / agentEvent', () => {
  it('appends text_delta chunks for the master', () => {
    let state = blank();
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: 10,
      event: 'text_delta',
      data: { text: 'hello ' },
    });
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: 10,
      event: 'text_delta',
      data: { text: 'world' },
    });
    expect(state.masterState?.textChunks).toEqual(['hello ', 'world']);
  });

  it('creates a subordinate slot on first event', () => {
    const state = applyAgentEvent(blank(), {
      agent: 'reviewer',
      agentRunId: 20,
      event: 'text_delta',
      data: { text: 'meh' },
    });
    expect(state.subordinateStates.get(20)?.textChunks).toEqual(['meh']);
  });

  it('dedupes tool_call_start by id', () => {
    let state = blank();
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: 10,
      event: 'tool_call_start',
      data: { id: 't1', name: 'fs.read' },
    });
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: 10,
      event: 'tool_call_start',
      data: { id: 't1', name: 'fs.read' },
    });
    expect(state.masterState?.toolCalls).toHaveLength(1);
  });

  it('tool_call_result flips status to done with duration', () => {
    let state = blank();
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: 10,
      event: 'tool_call_start',
      data: { id: 't1', name: 'fs.read' },
    });
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: 10,
      event: 'tool_call_result',
      data: { id: 't1', duration_ms: 42 },
    });
    expect(state.masterState?.toolCalls[0].status).toBe('done');
    expect(state.masterState?.toolCalls[0].durationMs).toBe(42);
  });

  it('done with reason completed flips status', () => {
    let state = blank();
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: 10,
      event: 'text_delta',
      data: { text: 'x' },
    });
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: 10,
      event: 'done',
      data: { reason: 'completed' },
    });
    expect(state.masterState?.status).toBe('completed');
  });

  it('fallback_activated lands in fallbackNotices (most recent first, capped at 5)', () => {
    let state = blank();
    for (let i = 0; i < 7; i++) {
      state = applyAgentEvent(state, {
        agent: 'master',
        agentRunId: 10,
        event: 'fallback_activated',
        data: { error: `oops-${i}` },
      });
    }
    expect(state.fallbackNotices).toHaveLength(5);
    expect(state.fallbackNotices[0].error).toBe('oops-6');
  });
});

describe('stream-handlers / boardEvent', () => {
  it('appends in order and dedupes by id', () => {
    let state = blank();
    state = applyBoardEntry(state, {
      id: 1,
      author_role: 'master',
      agent_run_id: null,
      kind: 'message',
      content: 'first',
      mentions: [],
      created_at: '2025-01-01',
    });
    state = applyBoardEntry(state, {
      id: 2,
      author_role: 'master',
      agent_run_id: null,
      kind: 'message',
      content: 'second',
      mentions: [],
      created_at: '2025-01-01',
    });
    state = applyBoardEntry(state, {
      id: 1,
      author_role: 'master',
      agent_run_id: null,
      kind: 'message',
      content: 'first-replay',
      mentions: [],
      created_at: '2025-01-01',
    });
    expect(state.boardMessages.map((m) => m.content)).toEqual(['first', 'second']);
  });
});

describe('stream-handlers / masterPromptEvent', () => {
  it('applyMasterPrompt upserts by id', () => {
    let state = blank();
    state = applyMasterPrompt(state, prompt({ id: 1, body: 'q1' }));
    state = applyMasterPrompt(state, prompt({ id: 1, body: 'q1-revised' }));
    expect(state.masterPrompts.get(1)?.body).toBe('q1-revised');
  });

  it('hydrateMasterPrompts keeps existing entries (no overwrite)', () => {
    let state = blank();
    state = applyMasterPrompt(state, prompt({ id: 1, body: 'live' }));
    state = hydrateMasterPrompts(state, [
      prompt({ id: 1, body: 'rest' }),
      prompt({ id: 2, body: 'fresh' }),
    ]);
    expect(state.masterPrompts.get(1)?.body).toBe('live');
    expect(state.masterPrompts.get(2)?.body).toBe('fresh');
  });

  it('hydrateMasterPrompts is a no-op when nothing new', () => {
    let state = blank();
    state = applyMasterPrompt(state, prompt({ id: 1 }));
    const ref = state;
    state = hydrateMasterPrompts(state, [prompt({ id: 1, body: 'stale' })]);
    expect(state).toBe(ref);
  });
});

describe('stream-handlers / agentStatusEvent', () => {
  it('applyAgentStatus updates the master row', () => {
    let state = applyAgentEvent(blank(), {
      agent: 'master',
      agentRunId: 10,
      event: 'text_delta',
      data: { text: 'x' },
    });
    state = applyAgentStatus(state, {
      agentRunId: 10,
      role: 'master',
      status: 'waiting',
      message: 'idle',
    });
    expect(state.masterState?.status).toBe('waiting');
    expect(state.masterState?.statusMessage).toBe('idle');
  });

  it('applyAgentStatus updates a subordinate slot when present', () => {
    let state = applyAgentEvent(blank(), {
      agent: 'reviewer',
      agentRunId: 20,
      event: 'text_delta',
      data: { text: 'x' },
    });
    state = applyAgentStatus(state, {
      agentRunId: 20,
      role: 'reviewer',
      status: 'completed',
      message: 'done',
    });
    expect(state.subordinateStates.get(20)?.status).toBe('completed');
  });

  it('applySubordinateWaitingStatus is a no-op when the agent is unknown', () => {
    const state = applySubordinateWaitingStatus(blank(), 99, 'waiting_plan');
    expect(state).toEqual(blank());
  });

  it('applySessionIdle bumps masterErrorDetail on master_error reason', () => {
    let state = applyAgentEvent(blank(), {
      agent: 'master',
      agentRunId: 10,
      event: 'text_delta',
      data: { text: 'x' },
    });
    state = applySessionIdle(state, { reason: 'master_error', errorDetail: 'boom' });
    expect(state.masterState?.status).toBe('error');
    expect(state.masterErrorDetail).toBe('boom');
  });
});
