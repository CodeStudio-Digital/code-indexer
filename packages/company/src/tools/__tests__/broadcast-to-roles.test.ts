/**
 * Tests for the broadcast_to_roles master tool — multicast one message to
 * several roles via the inbox, plus a board mirror.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '@mcp/company/orchestrator-port.js';
import { buildMasterTools } from '@mcp/company/tools/master-tools.js';

const MASTER_AGENT_RUN_ID = 'a0000000-0000-4000-8000-000000000007';
const BACKEND_MESSAGE_ID = 'f0000000-0000-4000-8000-000000000101';
const FRONTEND_MESSAGE_ID = 'f0000000-0000-4000-8000-000000000102';

function fakeOrchestrator(overrides: Partial<Record<string, unknown>>): CompanyOrchestrator {
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in overrides) return overrides[prop];
        return () => undefined;
      },
    },
  ) as unknown as CompanyOrchestrator;
}

function broadcastTool(orch: CompanyOrchestrator) {
  const tool = buildMasterTools(orch).find((t) => t.name === 'broadcast_to_roles');
  if (!tool) throw new Error('broadcast_to_roles not built');
  return tool;
}

describe('broadcast_to_roles', () => {
  it('sends the message to each unique role and mirrors to the board', async () => {
    const inboxSend = vi.fn((args: { toRole: string }) => ({
      message: {
        id: args.toRole === 'backend' ? BACKEND_MESSAGE_ID : FRONTEND_MESSAGE_ID,
      },
      deliveredImmediately: true,
    }));
    const postToBoard = vi.fn();
    const orch = fakeOrchestrator({
      inboxSend,
      postToBoard,
      getMasterAgentRunId: () => MASTER_AGENT_RUN_ID,
    });
    const res = await broadcastTool(orch).handler(
      { roles: ['backend', 'frontend', 'backend'], message: 'Auth header is X-Token' },
      {} as never,
    );
    expect(res.isError).toBeFalsy();
    // Deduped to 2 unique roles.
    expect(inboxSend).toHaveBeenCalledTimes(2);
    expect(inboxSend).toHaveBeenCalledWith(
      expect.objectContaining({ fromRole: 'master', toRole: 'backend', kind: 'notify', wait: false }),
    );
    expect(postToBoard).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty role list', async () => {
    const res = await broadcastTool(fakeOrchestrator({})).handler({ roles: [], message: 'hi' }, {} as never);
    expect(res.isError).toBe(true);
  });

  it('records a per-role failure without aborting the whole broadcast', async () => {
    const inboxSend = vi.fn((args: { toRole: string }) => {
      if (args.toRole === 'frontend') throw new Error('no such role');
      return { message: { id: BACKEND_MESSAGE_ID }, deliveredImmediately: false };
    });
    const orch = fakeOrchestrator({
      inboxSend,
      postToBoard: vi.fn(),
      getMasterAgentRunId: () => MASTER_AGENT_RUN_ID,
    });
    const res = await broadcastTool(orch).handler(
      { roles: ['backend', 'frontend'], message: 'ping' },
      {} as never,
    );
    expect(res.isError).toBeFalsy();
    expect(String(res.content)).toMatch(/FAILED/);
    expect(inboxSend).toHaveBeenCalledTimes(2);
  });
});
