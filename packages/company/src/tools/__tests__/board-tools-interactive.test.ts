import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestratorPort as CompanyOrchestrator } from '@mcp/company/orchestrator-port.js';
import { buildBoardTools } from '../board-tools.js';

function postTool(orchestrator: CompanyOrchestrator) {
  const tool = buildBoardTools(orchestrator, 'backend', 'agent-1')
    .find((candidate) => candidate.name === 'post_to_board');
  if (!tool) throw new Error('post_to_board not built');
  return tool;
}

describe('post_to_board interactive ordering', () => {
  it('arms the input waiter before a synchronous plan auto-approval', async () => {
    let resolveInput: ((value: string) => void) | undefined;
    const waitForUserInput = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveInput = resolve;
      }),
    );
    const emit = vi.fn((event: string) => {
      if (event === 'plan_posted') {
        resolveInput?.(JSON.stringify({ approved: true, feedback: 'auto' }));
      }
    });
    const tool = postTool({} as CompanyOrchestrator);

    const result = await tool.handler(
      {
        content: 'Approve this plan',
        kind: 'decision',
        awaits_response: { mode: 'approval' },
      },
      {
        runner: { waitForUserInput, emit },
        recordPlan: vi.fn(),
      } as unknown as ToolContext,
    );

    expect(waitForUserInput).toHaveBeenCalledBefore(emit);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('Post approved');
  });

  it('never turns a final deliverable into an interactive gate', async () => {
    const postToBoard = vi.fn().mockResolvedValue(undefined);
    const tool = postTool({ postToBoard } as unknown as CompanyOrchestrator);
    const waitForUserInput = vi.fn();

    const result = await tool.handler(
      {
        content: 'Implementation and tests complete',
        kind: 'deliverable',
        awaits_response: { mode: 'approval' },
      },
      {
        runner: { waitForUserInput, emit: vi.fn() },
      } as unknown as ToolContext,
    );

    expect(postToBoard).toHaveBeenCalledWith(
      'backend',
      'agent-1',
      'deliverable',
      'Implementation and tests complete',
    );
    expect(waitForUserInput).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
  });

  it('records a blocker without aborting the agent or Company', async () => {
    const postToBoard = vi.fn().mockResolvedValue(undefined);
    const abort = vi.fn();
    const tool = postTool({ postToBoard } as unknown as CompanyOrchestrator);

    const result = await tool.handler(
      {
        content: 'Frontend test command enters watch mode',
        kind: 'blocker',
      },
      {
        runner: { abort },
      } as unknown as ToolContext,
    );
    // `queueMicrotask` takes a zero-argument callback, so `resolve` cannot be
    // passed straight through — wrap it (same flush, types line up).
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(postToBoard).toHaveBeenCalledWith(
      'backend',
      'agent-1',
      'blocker',
      'Frontend test command enters watch mode',
    );
    expect(abort).not.toHaveBeenCalled();
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('[blocker]');
  });
});
