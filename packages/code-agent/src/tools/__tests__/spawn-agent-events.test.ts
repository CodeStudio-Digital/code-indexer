import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';

vi.mock('@mcp/code-agent/tools/implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/code-agent/tools/implement-subagent.js')>();
  return { ...actual, runSubagent: vi.fn() };
});

vi.mock('@mcp/services/sub-agent-cache/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/services/sub-agent-cache/index.js')>();
  return {
    ...actual,
    isGlobalSubAgentCacheEnabled: vi.fn(() => false),
    tryGlobalSubAgentRead: vi.fn(() => null),
    writeGlobalSubAgentResult: vi.fn(),
  };
});

const { buildSpawnAgentTool } = await import('@mcp/code-agent/tools/spawn-agent.js');
const { runSubagent } = await import('@mcp/code-agent/tools/implement-subagent.js');
const { isGlobalSubAgentCacheEnabled, tryGlobalSubAgentRead } = await import('@mcp/services/sub-agent-cache/index.js');

const runSingle = runSubagent as unknown as ReturnType<typeof vi.fn>;
const cacheEnabled = isGlobalSubAgentCacheEnabled as unknown as ReturnType<typeof vi.fn>;
const cacheRead = tryGlobalSubAgentRead as unknown as ReturnType<typeof vi.fn>;

function setup() {
  const emit = vi.fn();
  const ctx = {
    cwd: 'D:/MCP',
    runner: { sessionId: 42, agentLoopV2: false, emit },
  } as unknown as ToolContext;
  const tool = buildSpawnAgentTool(
    { provider: { name: 'openai', model: 'gpt-test' }, parentTools: [] } as never,
    new ToolRegistry(),
  );
  return { emit, ctx, tool };
}

function payloadFor(emit: ReturnType<typeof vi.fn>, event: string): Record<string, unknown> {
  const call = emit.mock.calls.find(([name]) => name === event);
  if (!call) throw new Error(`missing ${event} event`);
  return call[1] as Record<string, unknown>;
}

beforeEach(() => {
  runSingle.mockReset();
  cacheEnabled.mockReset();
  cacheEnabled.mockReturnValue(false);
  cacheRead.mockReset();
  cacheRead.mockReturnValue(null);
});

describe('spawn_agent single-agent live events', () => {
  it('emits the complete report instead of a 500-character preview', async () => {
    const report = `# Findings\n\n${'Complete evidence. '.repeat(40)}`;
    runSingle.mockResolvedValue({
      reason: 'completed',
      finalText: report,
      usage: { input_tokens: 11, output_tokens: 120 },
      sandboxViolations: [],
      collected: { memos: [], snapshots: [], boardPosts: [] },
    });

    const { emit, ctx, tool } = setup();
    await tool.handler({ agents: [{ task: 'Write a detailed report', label: 'reporter' }] }, ctx);

    const completed = emit.mock.calls
      .filter(([name]) => name === 'agent_progress')
      .map(([, payload]) => payload as { event?: string; summary?: string })
      .find((payload) => payload.event === 'completed');
    expect(report.length).toBeGreaterThan(500);
    expect(completed?.summary).toBe(report);
  });

  it('emits the same start/progress/terminal/end lifecycle as a parallel group', async () => {
    runSingle.mockImplementation(async (_parent, spec) => {
      spec.onProgress?.({
        event: 'heartbeat',
        status: 'running',
        toolCallCount: 0,
        note: 'awaiting model',
      });
      spec.onProgress?.({
        event: 'tool_call',
        status: 'running',
        toolCallCount: 2,
        toolName: 'read_file',
      });
      return {
        reason: 'completed',
        finalText: 'Single agent summary',
        usage: { input_tokens: 11, output_tokens: 4 },
        sandboxViolations: [],
        collected: { memos: [], snapshots: [], boardPosts: [] },
      };
    });

    const { emit, ctx, tool } = setup();
    const result = await tool.handler({ agents: [{ task: 'Inspect the stream', label: 'stream scout' }] }, ctx);

    expect(result.isError).toBeFalsy();
    const names = emit.mock.calls.map(([name]) => name);
    expect(names).toEqual([
      'agents_group_start',
      'agent_progress',
      'agent_progress',
      'agent_progress',
      'agent_progress',
      'agents_group_end',
    ]);

    const start = payloadFor(emit, 'agents_group_start');
    const groupId = start.groupId;
    expect(start).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      agents: [{ index: 0, label: 'stream scout', task: 'Inspect the stream' }],
    });
    const progress = emit.mock.calls
      .filter(([name]) => name === 'agent_progress')
      .map(([, payload]) => payload);
    expect(progress).toEqual([
      expect.objectContaining({ groupId, agentIndex: 0, event: 'spawned', status: 'running' }),
      expect.objectContaining({ groupId, agentIndex: 0, event: 'heartbeat', note: 'awaiting model' }),
      expect.objectContaining({ groupId, agentIndex: 0, event: 'tool_call', toolCallCount: 2, lastToolName: 'read_file' }),
      expect.objectContaining({ groupId, agentIndex: 0, event: 'completed', status: 'completed', toolCallCount: 2 }),
    ]);
    expect(payloadFor(emit, 'agents_group_end')).toMatchObject({
      groupId,
      agentCount: 1,
      successCount: 1,
      completedCount: 1,
      partialCount: 0,
      failedCount: 0,
      totalUsage: { input_tokens: 11, output_tokens: 4 },
    });
  });

  it('closes the live group as failed if the child runner throws', async () => {
    runSingle.mockRejectedValue(new Error('provider unavailable'));
    const { emit, ctx, tool } = setup();

    await expect(tool.handler({ agents: [{ task: 'Fail visibly', label: 'failure probe' }] }, ctx))
      .rejects.toThrow('provider unavailable');

    expect(emit.mock.calls.some(([, payload]) => (
      (payload as { event?: string; error?: string })?.event === 'error'
      && (payload as { error?: string }).error === 'provider unavailable'
    ))).toBe(true);
    expect(payloadFor(emit, 'agents_group_end')).toMatchObject({
      agentCount: 1,
      successCount: 0,
      completedCount: 0,
      partialCount: 0,
      failedCount: 1,
    });
  });

  it('materializes and completes a live row for cache hits without spawning a child', async () => {
    const report = `Cached report:\n${'full cached evidence '.repeat(35)}`;
    cacheEnabled.mockReturnValue(true);
    cacheRead.mockReturnValue({
      cached: true,
      ageMs: 120,
      hitCount: 3,
      result: {
        header: '[cached]\n\n',
        body: report,
        usage: { input_tokens: 8, output_tokens: 2 },
      },
    });
    const { emit, ctx, tool } = setup();

    const result = await tool.handler({ agents: [{ task: 'Use cached work', label: 'cache scout' }] }, ctx);

    expect(runSingle).not.toHaveBeenCalled();
    expect(String(result.content)).toContain('cache-hit');
    expect(emit.mock.calls.map(([name]) => name)).toEqual([
      'agents_group_start',
      'agent_progress',
      'agent_progress',
      'agents_group_end',
    ]);
    const progress = emit.mock.calls
      .filter(([name]) => name === 'agent_progress')
      .map(([, payload]) => payload as { event: string; note?: string; summary?: string });
    expect(progress.at(-1)).toMatchObject({ event: 'completed', note: 'cache hit', summary: report });
    expect(payloadFor(emit, 'agents_group_end')).toMatchObject({ completedCount: 1, failedCount: 0 });
  });

});
