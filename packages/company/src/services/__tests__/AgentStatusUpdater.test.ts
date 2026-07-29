/**
 * `publishStatus` is the spawn-time path that lets the dashboard learn about
 * a new subordinate live: it writes the DB status AND emits an `agent_status`
 * event carrying `coderSessionId` (so the agent's row is clickable at once).
 * `setStatusWithBoard` is its board-posting superset.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentStatusUpdater } from '@mcp/company/services/AgentStatusUpdater.js';

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000090';
const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000007';
const CODER_SESSION_ID = '00000000-0000-4000-8000-000000000042';

function make() {
  const updateAgentRunStatus = vi.fn(async () => null);
  const publish = vi.fn();
  const ctx = {
    companySessionId: COMPANY_SESSION_ID,
    companyFiles: { updateAgentRunStatus },
  } as never;
  const bus = { bus: null, publish, markEnded: vi.fn() } as never;
  return { updater: new AgentStatusUpdater(ctx, bus), updateAgentRunStatus, publish };
}

function makeApp() {
  const updateAgentRunStatus = vi.fn(async () => null);
  const publish = vi.fn();
  const getAgentRun = vi.fn(() => ({
    id: AGENT_RUN_ID,
    company_session_id: COMPANY_SESSION_ID,
    configured_provider: 'openai-chatgpt',
    configured_model: 'gpt-5.6-sol',
    provider: 'openai-chatgpt',
    model: 'gpt-5.6-sol',
    dispatch_source: 'app_studio',
    fallback_reason: null,
  }));
  const ctx = {
    runtimeKind: 'app_studio',
    companySessionId: COMPANY_SESSION_ID,
    companyFiles: {
      updateAgentRunStatus,
      getAgentRunSync: getAgentRun,
    },
  } as never;
  const bus = { bus: null, publish, markEnded: vi.fn() } as never;
  return { updater: new AgentStatusUpdater(ctx, bus), publish };
}

describe('AgentStatusUpdater.publishStatus', () => {
  it('writes status to the store and publishes agent_status with coderSessionId', () => {
    const { updater, updateAgentRunStatus, publish } = make();
    updater.publishStatus(AGENT_RUN_ID, 'backend', 'running', {
      coderSessionId: CODER_SESSION_ID,
    });
    expect(updateAgentRunStatus).toHaveBeenCalledWith(
      AGENT_RUN_ID,
      'running',
      undefined,
    );
    expect(publish).toHaveBeenCalledWith('agent_status', {
      agentRunId: AGENT_RUN_ID,
      role: 'backend',
      status: 'running',
      message: '',
      coderSessionId: CODER_SESSION_ID,
    });
  });

  it('setStatusWithBoard publishes (via publishStatus) AND posts a board line', () => {
    const { updater, publish } = make();
    const post = vi.fn();
    updater.setStatusWithBoard(AGENT_RUN_ID, 'backend', 'waiting', 'done', { post });
    expect(publish).toHaveBeenCalledWith('agent_status', {
      agentRunId: AGENT_RUN_ID,
      role: 'backend',
      status: 'waiting',
      message: 'done',
      coderSessionId: undefined,
    });
    expect(post).toHaveBeenCalledWith(
      'backend',
      AGENT_RUN_ID,
      'message',
      expect.stringContaining('waiting'),
    );
  });

  it('adds configured/effective model provenance for App-owned runs', () => {
    const { updater, publish } = makeApp();
    updater.publishStatus(AGENT_RUN_ID, 'backend', 'running', {
      coderSessionId: CODER_SESSION_ID,
    });

    expect(publish).toHaveBeenCalledWith('agent_status', expect.objectContaining({
      agentRunId: AGENT_RUN_ID,
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
