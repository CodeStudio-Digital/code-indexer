/**
 * `publishStatus` is the spawn-time path that lets the dashboard learn about
 * a new subordinate live: it writes the DB status AND emits an `agent_status`
 * event carrying `coderSessionId` (so the agent's row is clickable at once).
 * `setStatusWithBoard` is its board-posting superset.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentStatusUpdater } from '@mcp/company/services/AgentStatusUpdater.js';

function make() {
  const updateAgentRunStatus = vi.fn();
  const publish = vi.fn();
  const ctx = { companyStore: { updateAgentRunStatus } } as never;
  const bus = { bus: null, publish, markEnded: vi.fn() } as never;
  return { updater: new AgentStatusUpdater(ctx, bus), updateAgentRunStatus, publish };
}

function makeApp() {
  const updateAgentRunStatus = vi.fn();
  const publish = vi.fn();
  const getAgentRun = vi.fn(() => ({
    id: 7,
    company_session_id: 90,
    configured_provider: 'openai-chatgpt',
    configured_model: 'gpt-5.6-sol',
    provider: 'openai-chatgpt',
    model: 'gpt-5.6-sol',
    dispatch_source: 'app_studio',
    fallback_reason: null,
  }));
  const ctx = {
    runtimeKind: 'app_studio',
    companySessionId: 90,
    companyStore: { updateAgentRunStatus, getAgentRun },
  } as never;
  const bus = { bus: null, publish, markEnded: vi.fn() } as never;
  return { updater: new AgentStatusUpdater(ctx, bus), publish };
}

describe('AgentStatusUpdater.publishStatus', () => {
  it('writes status to the store and publishes agent_status with coderSessionId', () => {
    const { updater, updateAgentRunStatus, publish } = make();
    updater.publishStatus(7, 'backend', 'running', { coderSessionId: 42 });
    expect(updateAgentRunStatus).toHaveBeenCalledWith(7, 'running', undefined);
    expect(publish).toHaveBeenCalledWith('agent_status', {
      agentRunId: 7,
      role: 'backend',
      status: 'running',
      message: '',
      coderSessionId: 42,
    });
  });

  it('setStatusWithBoard publishes (via publishStatus) AND posts a board line', () => {
    const { updater, publish } = make();
    const post = vi.fn();
    updater.setStatusWithBoard(7, 'backend', 'waiting', 'done', { post });
    expect(publish).toHaveBeenCalledWith('agent_status', {
      agentRunId: 7,
      role: 'backend',
      status: 'waiting',
      message: 'done',
      coderSessionId: undefined,
    });
    expect(post).toHaveBeenCalledWith('backend', 7, 'message', expect.stringContaining('waiting'));
  });

  it('adds configured/effective model provenance for App-owned runs', () => {
    const { updater, publish } = makeApp();
    updater.publishStatus(7, 'backend', 'running', { coderSessionId: 42 });

    expect(publish).toHaveBeenCalledWith('agent_status', expect.objectContaining({
      agentRunId: 7,
      role: 'backend',
      configuredProvider: 'openai-chatgpt',
      configuredModel: 'gpt-5.6-sol',
      effectiveProvider: 'openai-chatgpt',
      effectiveModel: 'gpt-5.6-sol',
      dispatchSource: 'app_studio',
      fallbackReason: null,
    }));
  });
});
