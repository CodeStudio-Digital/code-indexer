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
});
