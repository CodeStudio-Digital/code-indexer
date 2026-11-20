/**
 * The parallel spawn path honours the session's parallelism limit
 * (`SubagentDeps.maxParallel`, from the runtime policy and the saved Ultra
 * settings) like the background and resume paths, instead of the pool's
 * built-in default.
 */
import { describe, expect, it, vi } from 'vitest';
import { newSessionId } from '@mcp/session-storage';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';

vi.mock('@mcp/code-agent/tools/implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/code-agent/tools/implement-subagent.js')>();
  return { ...actual, runSubagent: vi.fn(), runParallelAgents: vi.fn() };
});

const { buildSpawnAgentTool } = await import('@mcp/code-agent/tools/spawn-agent.js');
const { runParallelAgents } = await import('@mcp/code-agent/tools/implement-subagent.js');
const runParallel = runParallelAgents as unknown as ReturnType<typeof vi.fn>;

describe('spawn_agent parallel limit', () => {
  it('passes the session maxParallel to the parallel pool', async () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    const child = { reason: 'completed', finalText: 'done', usage, sandboxViolations: [],
      collected: { memos: [], snapshots: [], boardPosts: [] }, label: 'child', toolCallCount: 1 };
    runParallel.mockResolvedValue({ results: [child, child, child], totalUsage: usage });
    const tool = buildSpawnAgentTool(
      { provider: { name: 'openai', model: 'gpt-test' }, parentTools: [], maxParallel: 2 } as never,
      new ToolRegistry(),
    );
    const ctx = { cwd: 'D:/MCP', runner: { sessionId: newSessionId(), agentLoopV2: false, emit: vi.fn() } } as unknown as ToolContext;

    await tool.handler({ agents: [{ task: 'a' }, { task: 'b' }, { task: 'c' }] }, ctx);

    expect(runParallel).toHaveBeenCalledTimes(1);
    expect(runParallel.mock.calls[0]?.[0]).toMatchObject({ maxParallel: 2 });
  });
});
