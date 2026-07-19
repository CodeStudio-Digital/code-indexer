import { describe, expect, it } from 'vitest';
import type { AgentStreamState } from '../../../state/company/types.js';
import { collectActiveAppAgents, isActiveAppAgent } from '../AppStudioAgentsDropdown.js';

function agent(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    role: 'frontend',
    agentRunId: 2,
    coderSessionId: 22,
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
    const master = agent({ role: 'master', agentRunId: 1, coderSessionId: undefined });
    const subordinate = agent();
    const active = collectActiveAppAgents({
      masterState: master,
      subordinateStates: new Map([[subordinate.agentRunId, subordinate]]),
    }, 11);

    expect(active.map((item) => item.role)).toEqual(['master', 'frontend']);
    expect(active[0]?.coderSessionId).toBe(11);
  });
});
