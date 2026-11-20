import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newSessionId } from '@mcp/session-storage';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import { ToolCallLedger } from '@mcp/code-agent/core/tool-call-ledger.js';

vi.mock('@mcp/code-agent/tools/implement-subagent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mcp/code-agent/tools/implement-subagent.js')>();
  return { ...actual, runSubagent: vi.fn(), runParallelAgents: vi.fn() };
});

const { buildSpawnAgentTool } = await import('@mcp/code-agent/tools/spawn-agent.js');
const { runSubagent, runParallelAgents } = await import('@mcp/code-agent/tools/implement-subagent.js');

const runSingle = runSubagent as unknown as ReturnType<typeof vi.fn>;
const runParallel = runParallelAgents as unknown as ReturnType<typeof vi.fn>;

function setup() {
  const emit = vi.fn();
  const ctx = {
    cwd: 'D:/MCP',
    runner: { sessionId: newSessionId(), agentLoopV2: false, emit },
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
  runParallel.mockReset();
});

describe('spawn_agent single-agent live events', () => {
  it.each([1, 2])('propagates uncertain effects from %s child slots and never recommends replacement work', async count => {
    const result = { reason: 'error', effectOutcome: 'unknown', finalText: 'unconfirmed effect',
      usage: { input_tokens: 1, output_tokens: 0 }, sandboxViolations: [], collected: { memos: [], snapshots: [], boardPosts: [] } };
    runSingle.mockResolvedValue(result);
    runParallel.mockResolvedValue({ results: Array.from({ length: count }, () => ({ ...result, label: 'child', toolCallCount: 1 })), totalUsage: result.usage });
    const { ctx, tool } = setup();
    const output = await tool.handler({ agents: Array.from({ length: count }, () => ({ task: 'Write once', profile: 'implement' })) }, ctx);
    expect(output).toMatchObject({ isError: true, effectOutcome: 'unknown', error: { retryable: false } });
    expect(output.error?.suggestedAction).toContain('Reconcile');
    expect(output.content).not.toContain('resume_agent({');
  });

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

  it('returns a structured partial error while preserving a single child cutoff report and usage', async () => {
    const usage = { input_tokens: 13, output_tokens: 7 };
    runSingle.mockResolvedValue({
      reason: 'tool_budget',
      finalText: 'Useful work before the tool budget ended.',
      usage,
      sandboxViolations: [],
      collected: { memos: [], snapshots: [], boardPosts: [] },
      transcript: [{ role: 'user', content: [{ type: 'text', text: 'inspect' }] }],
      toolCallCount: 12,
    });
    const { ctx, tool } = setup();

    const result = await tool.handler({ agents: [{ task: 'Inspect deeply', label: 'budget scout' }] }, ctx);
    const ledgerEntry = new ToolCallLedger().record({
      name: 'spawn_agent',
      args: { agents: [{ task: 'Inspect deeply', label: 'budget scout' }] },
      content: String(result.content),
      isError: result.isError === true,
      executionClass: 'control',
    });

    expect(result.isError).toBe(true);
    expect(result.error).toMatchObject({
      code: 'SPAWN_AGENT_PARTIAL',
      kind: 'tool_error',
      retryable: true,
    });
    expect(result.structuredData).toMatchObject({
      kind: 'spawn_agent_result',
      status: 'partial',
      agentCount: 1,
      completedCount: 0,
      partialCount: 1,
      failedCount: 0,
      stillFailed: 1,
      resumableCount: 1,
    });
    expect(result.subUsage).toEqual(usage);
    expect(String(result.content)).toContain('Useful work before the tool budget ended.');
    expect(String(result.content)).toContain('resume_agent');
    expect(ledgerEntry.outcome).toBe('tool_error');
  });

  it('returns a structured failed error when the child terminates with a timeout failure', async () => {
    const usage = { input_tokens: 5, output_tokens: 2 };
    runSingle.mockResolvedValue({
      reason: 'error',
      finalText: 'subagent hard timeout reached',
      failureDetail: 'subagent hard timeout reached',
      usage,
      sandboxViolations: [],
      collected: { memos: [], snapshots: [], boardPosts: [] },
      transcript: [{ role: 'user', content: [{ type: 'text', text: 'verify' }] }],
      toolCallCount: 0,
    });
    const { ctx, tool } = setup();

    const result = await tool.handler({ agents: [{ task: 'Verify slowly', label: 'timeout probe' }] }, ctx);

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('SPAWN_AGENT_FAILED');
    expect(result.structuredData).toMatchObject({
      status: 'failed',
      completedCount: 0,
      partialCount: 0,
      failedCount: 1,
      stillFailed: 1,
    });
    expect(result.subUsage).toEqual(usage);
    expect(String(result.content)).toContain('subagent hard timeout reached');
  });

  it('returns a structured partial error when any child in a parallel group is incomplete', async () => {
    const completedUsage = { input_tokens: 4, output_tokens: 2 };
    const failedUsage = { input_tokens: 6, output_tokens: 3 };
    const totalUsage = { input_tokens: 10, output_tokens: 5 };
    runParallel.mockResolvedValue({
      results: [
        {
          reason: 'completed',
          finalText: 'First child completed.',
          usage: completedUsage,
          sandboxViolations: [],
          collected: { memos: [], snapshots: [], boardPosts: [] },
          label: 'first',
          toolCallCount: 2,
        },
        {
          reason: 'error',
          finalText: 'Second child failed.',
          usage: failedUsage,
          sandboxViolations: [],
          collected: { memos: [], snapshots: [], boardPosts: [] },
          transcript: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }],
          label: 'second',
          toolCallCount: 1,
        },
      ],
      totalUsage,
    });
    const { ctx, tool } = setup();

    const result = await tool.handler({
      agents: [
        { task: 'First task', label: 'first' },
        { task: 'Second task', label: 'second' },
      ],
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('SPAWN_AGENT_PARTIAL');
    expect(result.structuredData).toMatchObject({
      status: 'partial',
      agentCount: 2,
      completedCount: 1,
      partialCount: 0,
      failedCount: 1,
      stillFailed: 1,
      resumableCount: 1,
    });
    expect(result.subUsage).toEqual(totalUsage);
    expect(String(result.content)).toContain('First child completed.');
    expect(String(result.content)).toContain('Second child failed.');
  });
});
