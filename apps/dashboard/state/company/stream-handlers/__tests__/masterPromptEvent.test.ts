import { describe, expect, it } from 'vitest';
import type { MasterPrompt } from '@mcp/company-contracts';
import { INITIAL_STREAM_STATE, type StreamState } from '../../types.js';
import { applyMasterPrompt, hydrateMasterPrompts } from '../masterPromptEvent.js';

const SESSION_ID = '10000000-0000-4000-8000-000000000000';
const PROMPT_ID = '20000000-0000-4000-8000-000000000000';

function state(): StreamState {
  return {
    ...INITIAL_STREAM_STATE,
    masterPrompts: new Map(),
  };
}

function prompt(overrides: Partial<MasterPrompt> = {}): MasterPrompt {
  return {
    id: PROMPT_ID,
    company_session_id: SESSION_ID,
    agent_run_id: null,
    kind: 'question',
    runner_block_id: null,
    body: 'Choose a direction',
    options: null,
    allow_freeform: true,
    status: 'pending',
    answer: null,
    approved: null,
    feedback: null,
    created_at: '2026-07-27T10:00:00.000Z',
    resolved_at: null,
    ...overrides,
  };
}

describe('masterPromptEvent UUID identity', () => {
  it.each(['answered', 'cancelled'] as const)('keeps the persisted %s state through a stale SSE replay', (status) => {
    const pending = prompt();
    const terminal = prompt({ status, answer: status === 'answered' ? 'chosen' : null });
    const live = applyMasterPrompt(state(), pending);
    const hydrated = hydrateMasterPrompts(live, [terminal, pending]);
    expect(hydrated.masterPrompts.get(PROMPT_ID)).toEqual(terminal);
    expect(applyMasterPrompt(hydrated, pending)).toBe(hydrated);
    expect(applyMasterPrompt(hydrated, terminal)).toBe(hydrated);
  });

  it('upserts an SSE prompt by opaque UUID', () => {
    const pending = applyMasterPrompt(state(), prompt());
    const answered = applyMasterPrompt(
      pending,
      prompt({
        status: 'answered',
        answer: 'Filesystem',
        resolved_at: '2026-07-27T10:01:00.000Z',
      }),
    );

    expect(answered.masterPrompts.size).toBe(1);
    expect(answered.masterPrompts.get(PROMPT_ID)).toMatchObject({
      id: PROMPT_ID,
      status: 'answered',
      answer: 'Filesystem',
    });
  });

  it('does not let stale hydration overwrite a newer live prompt', () => {
    const live = applyMasterPrompt(
      state(),
      prompt({
        status: 'answered',
        answer: 'Filesystem',
        resolved_at: '2026-07-27T10:01:00.000Z',
      }),
    );
    const hydrated = hydrateMasterPrompts(live, [prompt()]);

    expect(hydrated).toBe(live);
    expect(hydrated.masterPrompts.get(PROMPT_ID)?.status).toBe('answered');
  });
});
