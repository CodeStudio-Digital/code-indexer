/**
 * A parallel execute_tasks wave gets the session store like the single-task
 * path does, so its children run durably (AgentRun fence, mutation fence,
 * subagent_run records and turn telemetry) instead of silently skipping it.
 */
import { describe, expect, it, vi } from 'vitest';
import { newSessionId } from '@mcp/session-storage';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CoderTask, TasksState } from '@mcp/session-storage/session-state-types.js';

vi.mock('../implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../implement-subagent.js')>();
  return { ...actual, runSubagent: vi.fn(), runParallelAgents: vi.fn() };
});

const { buildExecuteTasksTool } = await import('../execute-tasks.js');
const { runParallelAgents } = await import('../implement-subagent.js');

function task(id: string): CoderTask {
  return {
    id, title: id, description: `Do ${id}`, files: [`src/${id}.ts`], references: [], depends_on: [],
    suggested_mode: 'subagent', estimated_complexity: 'medium', kind: 'implement', status: 'pending',
    parallel_group: 'wave',
  };
}

describe('execute_tasks parallel wave durability', () => {
  it('passes the session store to the parallel wave', async () => {
    // Every store method resolves to nothing, so persistence stays inert.
    const sessionStore = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : async () => undefined) });
    vi.mocked(runParallelAgents).mockImplementation(async (_parent, agents) => ({
      results: agents.map((agent) => ({ label: agent.label, reason: 'completed', finalText: 'ok',
        usage: { input_tokens: 1, output_tokens: 1 }, sandboxViolations: [], toolCallCount: 1 })),
      totalUsage: { input_tokens: 2, output_tokens: 2 },
    }) as never);
    const state: TasksState = { summary: 'Run', tasks: [task('tsk_a'), task('tsk_b')], execution_mode: 'all-subagent',
      approved: true, current_task_id: null };
    const ctx = {
      cwd: 'D:/MCP', projectName: 'test',
      runner: { emit: vi.fn(), sessionId: newSessionId(), agentLoopV2: false, beginTaskScope: vi.fn(), currentTaskScopeId: vi.fn(() => null) },
      getTasksState: () => state, updateTaskStatus: vi.fn(), reportProgress: vi.fn(),
    } as unknown as ToolContext;
    const tool = buildExecuteTasksTool({
      provider: {} as never, parentTools: [], sessionStore: sessionStore as never,
      executeTasksRetryConfig: { maxRetries: 0, initialMs: 0, maxMs: 0, jitter: 0 },
    });

    await tool.handler({}, ctx);

    expect(vi.mocked(runParallelAgents)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runParallelAgents).mock.calls[0]?.[0].sessionStore).toBe(sessionStore);
  });
});
