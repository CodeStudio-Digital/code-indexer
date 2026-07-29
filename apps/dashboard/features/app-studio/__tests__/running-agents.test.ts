import { describe, expect, it } from 'vitest';
import type { AgentStreamState } from '../../../state/company/types.js';
import { collectActiveAppAgents, isActiveAppAgent } from '../AppStudioAgentsDropdown.js';

const MASTER_RUN_ID = '00000000-0000-0000-0000-000000000001';
const SUBORDINATE_RUN_ID = '00000000-0000-0000-0000-000000000002';
const MASTER_SESSION_ID = '00000000-0000-0000-0000-000000000003';
const SUBORDINATE_SESSION_ID = '00000000-0000-0000-0000-000000000004';

function agent(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    role: 'frontend',
    agentRunId: SUBORDINATE_RUN_ID,
    coderSessionId: SUBORDINATE_SESSION_ID,
    textChunks: [],
    toolCalls: [],
    status: 'running',
    ...overrides,
  };
}

describe('App Studio running agents', () => {
  it('keeps waiting and paused runs visible but excludes terminal runs', () => {
    expect(isActiveAppAgent(agent({ status: 'waiting_question' }))).toBe(true);
    expect(isActiveAppAgent(agent({ status: 'paused' }))).toBe(true);
    expect(isActiveAppAgent(agent({ status: 'completed' }))).toBe(false);
    expect(isActiveAppAgent(agent({ status: 'error' }))).toBe(false);
  });

  it('places Master first and uses the known Master coder session as fallback', () => {
    const master = agent({ role: 'master', agentRunId: MASTER_RUN_ID, coderSessionId: undefined });
    const subordinate = agent();
    const active = collectActiveAppAgents({
      masterState: master,
      subordinateStates: new Map([[subordinate.agentRunId!, subordinate]]),
    }, MASTER_SESSION_ID);

    expect(active.map((item) => item.role)).toEqual(['master', 'frontend']);
    expect(active[0]?.coderSessionId).toBe(MASTER_SESSION_ID);
  });
});
