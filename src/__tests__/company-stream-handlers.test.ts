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

const SESSION_ID = '00000000-0000-4000-8000-000000000042';
const MASTER_RUN_ID = '00000000-0000-4000-8000-000000000010';
const REVIEWER_RUN_ID = '00000000-0000-4000-8000-000000000020';
const UNKNOWN_RUN_ID = '00000000-0000-4000-8000-000000000099';
const PROMPT_1_ID = '00000000-0000-4000-8000-000000000101';
const PROMPT_2_ID = '00000000-0000-4000-8000-000000000102';
const BOARD_1_ID = '00000000-0000-4000-8000-000000000201';
const BOARD_2_ID = '00000000-0000-4000-8000-000000000202';

function blank(): StreamState {
  return { ...INITIAL_STREAM_STATE, subordinateStates: new Map(), masterPrompts: new Map(), boardMessages: [], fallbackNotices: [] };
}

function prompt(overrides: Partial<MasterPrompt> = {}): MasterPrompt {
  return {
    id: PROMPT_1_ID,
    company_session_id: SESSION_ID,
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
  it('updates the separate master preview from text deltas', () => {
    let state = blank();
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
      event: 'text_delta',
      data: { text: 'hello ' },
    });
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
      event: 'text_delta',
      data: { text: 'world' },
    });
    expect(state.agentTextPreviews.get('master')).toBe('hello world');
  });

  it('creates a subordinate slot on first event', () => {
    const state = applyAgentEvent(blank(), {
      agent: 'reviewer',
      agentRunId: REVIEWER_RUN_ID,
      event: 'text_delta',
      data: { text: 'meh' },
    });
    expect(state.subordinateStates.get(REVIEWER_RUN_ID)?.role).toBe('reviewer');
    expect(state.agentTextPreviews.get(REVIEWER_RUN_ID)).toBe('meh');
  });

  it('dedupes tool_call_start by id', () => {
    let state = blank();
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
      event: 'tool_call_start',
      data: { id: 't1', name: 'fs.read' },
    });
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
      event: 'tool_call_start',
      data: { id: 't1', name: 'fs.read' },
    });
    expect(state.masterState?.toolCalls).toHaveLength(1);
  });

  it('tool_call_result flips status to done with duration', () => {
    let state = blank();
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
      event: 'tool_call_start',
      data: { id: 't1', name: 'fs.read' },
    });
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
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
      agentRunId: MASTER_RUN_ID,
      event: 'text_delta',
      data: { text: 'x' },
    });
    state = applyAgentEvent(state, {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
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
        agentRunId: MASTER_RUN_ID,
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
      id: BOARD_1_ID,
      seq: 1,
      author_role: 'master',
      agent_run_id: null,
      kind: 'message',
      content: 'first',
      mentions: [],
      created_at: '2025-01-01',
    });
    state = applyBoardEntry(state, {
      id: BOARD_2_ID,
      seq: 2,
      author_role: 'master',
      agent_run_id: null,
      kind: 'message',
      content: 'second',
      mentions: [],
      created_at: '2025-01-01',
    });
    state = applyBoardEntry(state, {
      id: BOARD_1_ID,
      seq: 1,
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
    state = applyMasterPrompt(state, prompt({ id: PROMPT_1_ID, body: 'q1' }));
    state = applyMasterPrompt(state, prompt({ id: PROMPT_1_ID, body: 'q1-revised' }));
    expect(state.masterPrompts.get(PROMPT_1_ID)?.body).toBe('q1-revised');
  });

  it('hydrateMasterPrompts keeps existing entries (no overwrite)', () => {
    let state = blank();
    state = applyMasterPrompt(state, prompt({ id: PROMPT_1_ID, body: 'live' }));
    state = hydrateMasterPrompts(state, [
      prompt({ id: PROMPT_1_ID, body: 'rest' }),
      prompt({ id: PROMPT_2_ID, body: 'fresh' }),
    ]);
    expect(state.masterPrompts.get(PROMPT_1_ID)?.body).toBe('live');
    expect(state.masterPrompts.get(PROMPT_2_ID)?.body).toBe('fresh');
  });

  it('hydrateMasterPrompts is a no-op when nothing new', () => {
    let state = blank();
    state = applyMasterPrompt(state, prompt({ id: PROMPT_1_ID }));
    const ref = state;
    state = hydrateMasterPrompts(state, [prompt({ id: PROMPT_1_ID, body: 'stale' })]);
    expect(state).toBe(ref);
  });
});

describe('stream-handlers / agentStatusEvent', () => {
  it('applyAgentStatus updates the master row', () => {
    let state = applyAgentEvent(blank(), {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
      event: 'text_delta',
      data: { text: 'x' },
    });
    state = applyAgentStatus(state, {
      agentRunId: MASTER_RUN_ID,
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
      agentRunId: REVIEWER_RUN_ID,
      event: 'text_delta',
      data: { text: 'x' },
    });
    state = applyAgentStatus(state, {
      agentRunId: REVIEWER_RUN_ID,
      role: 'reviewer',
      status: 'completed',
      message: 'done',
    });
    expect(state.subordinateStates.get(REVIEWER_RUN_ID)?.status).toBe('completed');
  });

  it('applySubordinateWaitingStatus is a no-op when the agent is unknown', () => {
    const state = applySubordinateWaitingStatus(blank(), UNKNOWN_RUN_ID, 'waiting_plan');
    expect(state).toEqual(blank());
  });

  it('applySessionIdle bumps masterErrorDetail on master_error reason', () => {
    let state = applyAgentEvent(blank(), {
      agent: 'master',
      agentRunId: MASTER_RUN_ID,
      event: 'text_delta',
      data: { text: 'x' },
    });
    state = applySessionIdle(state, { reason: 'master_error', errorDetail: 'boom' });
    expect(state.masterState?.status).toBe('error');
    expect(state.masterErrorDetail).toBe('boom');
  });
});
