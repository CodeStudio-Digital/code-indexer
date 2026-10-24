import { describe, expect, it, vi } from 'vitest';
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '@mcp/company/orchestrator-port.js';
import { buildMasterTools } from '@mcp/company/tools/master-tools.js';

const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000101';
const CODER_SESSION_ID = '00000000-0000-4000-8000-000000000102';
const CARD_ID = '00000000-0000-4000-8000-000000000103';

function fakeOrchestrator(overrides: Partial<Record<string, unknown>>): CompanyOrchestrator {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop in overrides) return overrides[prop];
        return () => undefined;
      },
    },
  ) as unknown as CompanyOrchestrator;
}

function spawnTool(orchestrator: CompanyOrchestrator) {
  const tool = buildMasterTools(orchestrator).find(
    (candidate) => candidate.name === 'spawn_subordinate_agent',
  );
  if (!tool) throw new Error('spawn_subordinate_agent not built');
  return tool;
}

describe('spawn_subordinate_agent — Kanban assignment ordering', () => {
  it('does not expose an unassigned automatic card while the runner is booting', async () => {
    let resolveSpawn!: (result: {
      agentRunId: string;
      coderSessionId: string;
      status: string;
    }) => void;
    const spawnPending = new Promise<{
      agentRunId: string;
      coderSessionId: string;
      status: string;
    }>((resolve) => {
      resolveSpawn = resolve;
    });
    const createCard = vi.fn(() => ({ id: CARD_ID }));
    const spawnSubordinate = vi.fn(() => spawnPending);
    const assignAgent = vi.fn();
    const orchestrator = fakeOrchestrator({
      getMasterLastUserAttachments: () => [],
      spawnSubordinate,
      kanbanCreateCard: createCard,
      kanbanAddComment: vi.fn(),
      kanbanAssignAgent: assignAgent,
      kanbanGetCard: () => ({ id: CARD_ID, column: 'in_progress' }),
    });

    const pendingResult = spawnTool(orchestrator).handler(
      {
        role: 'backend',
        task: 'Implement the canonical blocked state in the board API.',
        wait: false,
      },
      {} as never,
    );

    await Promise.resolve();
    expect(createCard).not.toHaveBeenCalled();
    expect(assignAgent).not.toHaveBeenCalled();

    resolveSpawn({
      agentRunId: AGENT_RUN_ID,
      coderSessionId: CODER_SESSION_ID,
      status: 'running',
    });
    await pendingResult;

    expect(spawnSubordinate).toHaveBeenCalledWith(
      expect.objectContaining({ wait: false }),
    );
    expect(createCard).toHaveBeenCalledOnce();
    expect(assignAgent).toHaveBeenCalledWith(CARD_ID, AGENT_RUN_ID, 'backend');
  });

  it('assigns the card before honoring wait=true and returns the terminal status', async () => {
    let assigned = false;
    const spawnSubordinate = vi.fn(async () => ({
      agentRunId: AGENT_RUN_ID,
      coderSessionId: CODER_SESSION_ID,
      status: 'running' as const,
    }));
    const orchestrator = fakeOrchestrator({
      getMasterLastUserAttachments: () => [],
      getMasterAgentRunId: () => null,
      spawnSubordinate,
      kanbanCreateCard: () => ({ id: CARD_ID }),
      kanbanAddComment: vi.fn(),
      kanbanAssignAgent: () => {
        assigned = true;
      },
      kanbanGetCard: () => ({ id: CARD_ID, column: 'in_progress' }),
      listSubordinates: () => {
        expect(assigned).toBe(true);
        return [{ agentRunId: AGENT_RUN_ID, role: 'backend', status: 'completed' }];
      },
    });

    const tool = spawnTool(orchestrator);
    const result = await tool.handler(
      {
        role: 'backend',
        task: 'Implement the canonical blocked state in the board API.',
        wait: true,
      },
      {} as never,
    );

    expect(tool.timeoutMs).toBe(Infinity);
    expect(spawnSubordinate).toHaveBeenCalledWith(
      expect.objectContaining({ wait: false }),
    );
    expect(result.structuredData).toMatchObject({
      agentRunId: AGENT_RUN_ID,
      statusAtReturn: 'completed',
      waitOutcome: 'all_done',
    });
  });
});
