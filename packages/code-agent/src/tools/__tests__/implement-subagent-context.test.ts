import { describe, expect, it, vi } from 'vitest';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import { runSubagent } from '../implement-subagent.js';
import { buildExpandTools } from '../expand.js';

function captureProvider(): ChatProvider {
  let turn = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      turn++;
      if (turn === 1) {
        yield { type: 'tool_call_start', id: 'tu_capture', name: 'capture_context' };
        yield { type: 'tool_call_end', id: 'tu_capture', name: 'capture_context', input: {} };
        yield { type: 'done', stop_reason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', stop_reason: 'end_turn' };
    },
  };
}

describe('runSubagent context inheritance', () => {
  it('keeps plugin tools in their own tier and inherits smart selection', async () => {
    const seenCatalogs: string[][] = [];
    let turn = 0;
    const provider: ChatProvider = {
      name: 'mock',
      model: 'mock-model',
      setModel() {},
      async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
        turn += 1;
        seenCatalogs.push(request.tools.map((tool) => tool.name));
        if (turn === 1) {
          yield { type: 'tool_call_start', id: 'expand-1', name: 'expand_toolset' };
          yield {
            type: 'tool_call_end',
            id: 'expand-1',
            name: 'expand_toolset',
            input: { tier: 'plugin-acme', reason: 'task needs Acme' },
          };
          yield { type: 'done', stop_reason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', stop_reason: 'end_turn' };
      },
    };
    const pluginTool: CoderTool = {
      name: 'plugin__acme__lookup',
      description: 'Look up Acme records',
      parameters: { type: 'object', properties: {} },
      source: 'mcp_external',
      mutates: false,
      runtimeTier: { id: 'plugin-acme', displayName: 'Acme plugin' },
      handler: async () => ({ content: 'ok' }),
    };
    const expand = buildExpandTools(new Map([
      ['plugin-acme', { displayName: 'Acme plugin', toolCount: 1 }],
    ]))[0];
    const selection = vi.fn(async (tools: ChatRequest['tools']) => tools);

    const result = await runSubagent({
      provider,
      tools: [pluginTool, expand],
      ctx: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
      toolSelectionFilter: selection,
    }, {
      systemPrompt: 'Explore Acme.',
      profile: 'explore',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'inspect the Acme record' }] }],
      maxTurns: 4,
      limits: { maxToolCalls: 4, timeoutMs: 5_000, stallMs: 5_000 },
    });

    expect(result.reason).toBe('completed');
    expect(selection).toHaveBeenCalled();
    expect(seenCatalogs[0]).not.toContain(pluginTool.name);
    expect(seenCatalogs[0]).toContain('expand_toolset');
    expect(seenCatalogs[1]).toContain(pluginTool.name);
  });

  it('keeps the full specialist surface exact and bypasses smart selection', async () => {
    const seenCatalogs: string[][] = [];
    const provider: ChatProvider = {
      name: 'mock',
      model: 'mock-model',
      setModel() {},
      async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
        seenCatalogs.push(request.tools.map((tool) => tool.name));
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', stop_reason: 'end_turn' };
      },
    };
    const pluginTool: CoderTool = {
      name: 'plugin__acme__lookup',
      description: 'Look up Acme records',
      parameters: { type: 'object', properties: {} },
      source: 'mcp_external',
      mutates: false,
      runtimeTier: { id: 'plugin-acme', displayName: 'Acme plugin' },
      handler: async () => ({ content: 'ok' }),
    };
    const selection = vi.fn(async (tools: ChatRequest['tools']) => tools.slice(0, 1));

    await runSubagent({
      provider,
      tools: [pluginTool],
      ctx: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
      toolSelectionFilter: selection,
    }, {
      systemPrompt: 'Full access.',
      profile: 'full',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'use the full exact surface' }] }],
      maxTurns: 2,
      limits: { maxToolCalls: 1, timeoutMs: 5_000, stallMs: 5_000 },
    });

    expect(selection).not.toHaveBeenCalled();
    expect(seenCatalogs[0]).toContain(pluginTool.name);
  });

  it('passes global workspace and execution context fields to subagent tools', async () => {
    let seenContext: ToolContext | undefined;
    const captureTool: CoderTool = {
      name: 'capture_context',
      description: 'capture context',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      handler: async (_args, ctx) => {
        seenContext = ctx;
        return { content: 'captured' };
      },
    };

    const overlayByRoot = new Map();
    const ports = { fs: { kind: 'fs-port' }, shell: { kind: 'shell-port' } } as unknown as ToolContext['ports'];
    const runtimeEnv = { env: { PHP_VERSION: '8.3' } } as unknown as ToolContext['runtimeEnv'];
    const globalWorkspace: NonNullable<ToolContext['globalWorkspace']> = {
      syntheticProjectName: '__global_abc',
      rootPath: '/tmp/global',
      projects: [{
        projectId: 11,
        name: 'Backend Loyalty',
        slug: 'backend_loyalty',
        rootPath: '/repo/backend',
        isPrimary: true,
      }],
    };

    const parentContext = {
      cwd: '/tmp/global',
      projectName: '__global_abc',
      globalWorkspace,
      roots: [{ projectId: 12, name: 'Intranet', slug: 'intranet', rootPath: '/repo/intranet' }],
      overlayByRoot,
      projectId: 99,
      projectIndexed: true,
      runtimeEnv,
      ports,
      sessionId: 1234,
    } as ToolContext;

    const result = await runSubagent(
      {
        provider: captureProvider(),
        tools: [captureTool],
        ctx: parentContext,
        sessionId: 1234,
      },
      {
        systemPrompt: 'You are a test subagent.',
        allowlist: null,
        initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'capture' }] }],
        maxTurns: 5,
        limits: { maxToolCalls: 0, timeoutMs: 5_000, stallMs: 5_000 },
      },
    );

    expect(result.reason).toBe('completed');
    expect(seenContext?.cwd).toBe('/tmp/global');
    expect(seenContext?.projectName).toBe('__global_abc');
    expect(seenContext?.globalWorkspace).toBe(globalWorkspace);
    expect(seenContext?.roots).toBe(parentContext.roots);
    expect(seenContext?.overlayByRoot).toBe(overlayByRoot);
    expect(seenContext?.projectId).toBe(99);
    expect(seenContext?.projectIndexed).toBe(true);
    expect(seenContext?.runtimeEnv).toBe(runtimeEnv);
    expect(seenContext?.ports).toBe(ports);
    expect(seenContext?.sessionId).toBe(1234);
  });

  it('persists every child turn and correlates parent, spawn, run and profile', async () => {
    const turns: Array<Record<string, unknown>> = [];
    const starts: Array<Record<string, unknown>> = [];
    const calls: Array<Record<string, unknown>> = [];
    const completions: Array<Record<string, unknown>> = [];
    const fakeStore = {
      recordTurnTelemetry(input: Record<string, unknown>) { turns.push(input); return turns.length; },
      startSubagentRun(input: Record<string, unknown>) { starts.push(input); },
      recordSubagentToolCall(input: Record<string, unknown>) { calls.push(input); },
      completeSubagentRun(input: Record<string, unknown>) { completions.push(input); },
    };
    const captureTool: CoderTool = {
      name: 'capture_context',
      description: 'capture context',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      parallelSafe: true,
      handler: async () => ({ content: 'new symbol: TelemetryProbe' }),
    };
    const parentRunner = { runId: 'parent-run-1', emit() {} };
    const result = await runSubagent({
      provider: captureProvider(),
      tools: [captureTool],
      ctx: {
        cwd: process.cwd(),
        projectName: 'test',
        runner: parentRunner,
      } as unknown as ToolContext,
      sessionId: 77,
      sessionStore: fakeStore as never,
    }, {
      systemPrompt: 'You are a telemetry test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'capture' }] }],
      maxTurns: 5,
      profile: 'explore',
      spawnId: 'spawn-abc',
      limits: { maxToolCalls: 0, timeoutMs: 5_000, stallMs: 5_000 },
    });

    expect(result.reason).toBe('completed');
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => turn.is_subagent === true)).toBe(true);
    expect(turns.every((turn) => turn.parent_run_id === 'parent-run-1')).toBe(true);
    expect(turns.every((turn) => turn.subagent_profile === 'explore')).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ parent_run_id: 'parent-run-1', spawn_id: 'spawn-abc', profile: 'explore' });
    expect(calls).toHaveLength(1);
    expect(calls[0].run_id).toBe(starts[0].run_id);
    expect(calls[0].logical_operation_id).toEqual(expect.any(String));
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ run_id: starts[0].run_id, reason: 'completed', turns: 2, tool_calls: 1 });
  });
});
