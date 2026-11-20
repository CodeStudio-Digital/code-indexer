import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { asAgentRunId, newSessionId } from '@mcp/session-storage';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import { runSubagent, runParallelAgents } from '../implement-subagent.js';

const PARENT_RUN_ID = asAgentRunId(
  '11111111-1111-4111-8111-111111111111',
);

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
  it('inherits scoped memory and confirms only bodies included in the child prompt', async () => {
    const requests: ChatRequest[] = [];
    const onMemoryInjected = vi.fn();
    const getRelevantProjectMemory = vi.fn(async () => Array.from({ length: 5 }, (_, i) => ({
      id: String(i + 1), title: `Inherited fact ${i}`, content: `Verified memory body ${i}`,
    })));
    const provider: ChatProvider = { name: 'fixture', model: 'mock-model', setModel() {}, async *chat(request) {
      requests.push(request);
      yield { type: 'text_delta', text: 'Inspection complete' };
      yield { type: 'done', stop_reason: 'end_turn' };
    } };
    const result = await runSubagent({ provider, tools: [], ctx: { cwd: process.cwd(), projectName: 'test', runner: {
      runId: PARENT_RUN_ID, emit: vi.fn(), getMemoryContext: () => ({ getRelevantProjectMemory, onMemoryInjected,
        getUserMemoryIndex: () => [{ title: 'Global language', excerpt: 'Use Portuguese' }] }),
    } } as unknown as ToolContext }, { systemPrompt: 'Inspect the assigned project', profile: 'explore', allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the cache invalidation behavior' }] }], maxTurns: 2 });
    expect(result.reason).toBe('completed');
    expect(getRelevantProjectMemory).toHaveBeenCalled();
    expect(onMemoryInjected).toHaveBeenCalledExactlyOnceWith(['1', '2', '3']);
    const input = JSON.stringify(requests[0]?.messages);
    expect(input).toContain('Verified memory body 0');
    expect(input).not.toContain('Verified memory body 3');
    expect(input).toContain('Use Portuguese');
  });
  it('supplies opaque evidence references in tool bodies and accepts only the observed receipt', async () => {
    let turn = 0;
    const provider: ChatProvider = { name: 'fixture', model: 'fixture', setModel() {}, async *chat(request) {
      if (++turn === 1) {
        yield { type: 'tool_call_start', id: 'opaque-call-123', name: 'capture_context' };
        yield { type: 'tool_call_end', id: 'opaque-call-123', name: 'capture_context', input: {} };
        yield { type: 'done', stop_reason: 'tool_use' }; return;
      }
      const block = request.messages.flatMap(message => message.content).find(block => block.type === 'tool_result');
      if (!block || block.type !== 'tool_result') throw new Error('missing observed result');
      const reference = JSON.parse(block.content.split('\n')[0]).evidenceReference;
      expect(reference).toBe('tool:opaque-call-123');
      yield { type: 'text_delta', text: JSON.stringify({ schemaVersion: 1, status: 'completed', summary: 'Captured', artifacts: [],
        evidence: [{ kind: 'inspection', reference, outcome: 'passed' }], acceptance: 'accepted', effectOutcome: 'confirmed',
        criteria: [{ text: 'Captured the fixture', status: 'met', evidence: [reference] }] }) };
      yield { type: 'done', stop_reason: 'end_turn' };
    } };
    const tool: CoderTool = { name: 'capture_context', source: 'native', description: 'Capture fixture', parameters: { type: 'object', properties: {} },
      mutates: false, handler: async () => ({ content: 'Fixture captured' }) };
    const result = await runSubagent({ provider, tools: [tool], ctx: { cwd: process.cwd(), projectName: 'test' } as ToolContext },
      { systemPrompt: 'Inspect', initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Capture fixture' }] }],
        profile: 'explore', allowlist: null, maxTurns: 3, acceptance: ['Captured the fixture'] });
    expect(result.workResult?.acceptance).toBe('accepted');
  });
  it('keeps typed results and execution snapshots through the parallel adapter', async () => {
    const provider: ChatProvider = { name: 'fixture', model: 'fixture', setModel() {}, async *chat() {
      yield { type: 'text_delta', text: 'Inspection complete' };
      yield { type: 'done', stop_reason: 'end_turn' };
    } };
    const result = await runParallelAgents({ provider, tools: [], ctx: { cwd: process.cwd(), projectName: 'test' } as ToolContext },
      [{ task: 'Inspect only', label: 'inspect', maxTurns: 7, profile: 'explore', reasoningEffort: 'high' }], 'Inspect only', null, () => {});
    expect(result.results[0].execution).toMatchObject({ provider: 'fixture', model: 'fixture', effort: 'high', maxTurns: 7 });
    expect(result.results[0].workResult).toMatchObject({ schemaVersion: 1, status: 'completed', acceptance: 'unverified' });
  });
  it('keeps the full specialist surface exact', async () => {
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
    await runSubagent({
      provider,
      tools: [pluginTool],
      ctx: { cwd: process.cwd(), projectName: 'test' } as ToolContext,
    }, {
      systemPrompt: 'Full access.',
      profile: 'full',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'use the full exact surface' }] }],
      maxTurns: 2,
      limits: { maxToolCalls: 1, timeoutMs: 5_000, stallMs: 5_000 },
    });

    expect(seenCatalogs[0]).toContain(pluginTool.name);
  });

  it('passes global workspace and execution context fields to subagent tools', async () => {
    const sessionId = newSessionId();
    let seenContext: ToolContext | undefined;
    const captureTool: CoderTool = {
      name: 'capture_context',
      description: 'capture context',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      mutates: false,
      handler: async (_args, ctx) => {
        seenContext = ctx;
        return { content: 'captured' };
      },
    };

    const overlayByRoot = new Map();
    const ports = { fs: { kind: 'fs-port' }, shell: { kind: 'shell-port' } } as unknown as ToolContext['ports'];
    const runtimeEnv = { env: { PHP_VERSION: '8.3' } } as unknown as ToolContext['runtimeEnv'];
    const globalWorkspace: NonNullable<ToolContext['globalWorkspace']> = {
      sessionTitle: 'Global abc',
      primaryRootPath: '/repo/backend',
      projects: [
        {
          projectId: 11,
          name: 'Backend Loyalty',
          slug: 'backend_loyalty',
          rootPath: '/repo/backend',
          isPrimary: true,
        },
        {
          projectId: 12,
          name: 'Intranet',
          slug: 'intranet',
          rootPath: '/repo/intranet',
          isPrimary: false,
        },
      ],
    };

    const parentContext = {
      outcomeRecovery: { toolUseIds: ['parent-uncertain-call'] },
      cwd: '/repo/backend',
      projectName: 'Backend Loyalty',
      globalWorkspace,
      roots: [{ projectId: 12, name: 'Intranet', slug: 'intranet', rootPath: '/repo/intranet' }],
      overlayByRoot,
      projectId: 11,
      projectIndexed: true,
      runtimeEnv,
      ports,
      sessionId,
    } as ToolContext;

    const result = await runSubagent(
      {
        provider: captureProvider(),
        tools: [captureTool],
        ctx: parentContext,
        sessionId,
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
    expect(seenContext?.cwd).toBe('/repo/backend');
    expect(seenContext?.projectName).toBe('Backend Loyalty');
    expect(seenContext?.globalWorkspace).toBe(globalWorkspace);
    expect(seenContext?.roots).toBe(parentContext.roots);
    expect(seenContext?.overlayByRoot).toBe(overlayByRoot);
    expect(seenContext?.projectId).toBe(11);
    expect(seenContext?.projectIndexed).toBe(true);
    expect(seenContext?.runtimeEnv).toBe(runtimeEnv);
    expect(seenContext?.ports).toBe(ports);
    expect(seenContext?.sessionId).toBe(sessionId);
    expect(seenContext?.outcomeRecovery?.toolUseIds).toEqual(['parent-uncertain-call']);
  });

  it.each([false, true])('persists child turns and the durable terminal classification, uncertain=%s', async uncertain => {
    const sessionId = newSessionId();
    const turns: Array<Record<string, unknown>> = [];
    const starts: Array<Record<string, unknown>> = [];
    const calls: Array<Record<string, unknown>> = [];
    const completions: Array<Record<string, unknown>> = [];
    const bundlePath = join(process.cwd(), '.tmp', 'subagent-telemetry', sessionId);
    const fakeStore = {
      async getSession() {
        return { id: sessionId };
      },
      catalog: {
        get() {
          return { location: { bundle_path: bundlePath } };
        },
      },
      repository: {
        async writeEntity(
          _location: unknown,
          _directory: string,
          _id: string,
          data: Record<string, unknown>,
        ) {
          turns.push(data);
        },
      },
      async startSubagentRun(input: Record<string, unknown>) {
        starts.push(input);
        return {
          session_id: sessionId,
          run_id: String(input.run_id),
          entity_id: newSessionId(),
          fence_token: newSessionId(),
        };
      },
      async heartbeatSubagentRun() {},
      async assertSubagentRunFence() {},
      async recordSubagentToolCall(input: Record<string, unknown>) { calls.push(input); },
      async completeSubagentRun(input: Record<string, unknown>) { completions.push(input); },
    };
    const captureTool: CoderTool = {
      name: 'capture_context',
      description: 'capture context',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      parallelSafe: true,
      handler: async () => uncertain ? { content: 'ACK lost', isError: true, effectOutcome: 'unknown' as const }
        : { content: 'new symbol: TelemetryProbe' },
    };
    const parentRunner = { runId: PARENT_RUN_ID, emit() {} };
    const result = await runSubagent({
      provider: captureProvider(),
      tools: [captureTool],
      ctx: {
        cwd: process.cwd(),
        projectName: 'test',
        runner: parentRunner,
      } as unknown as ToolContext,
      sessionId,
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

    expect(result.reason).toBe(uncertain ? 'error' : 'completed');
    expect(result.effectOutcome).toBe(uncertain ? 'unknown' : undefined);
    expect(turns).toHaveLength(uncertain ? 1 : 2);
    expect(turns.every((turn) => turn.is_subagent === true)).toBe(true);
    expect(turns.every((turn) => turn.parent_run_id === PARENT_RUN_ID)).toBe(true);
    expect(turns.every((turn) => turn.subagent_profile === 'explore')).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ parent_run_id: PARENT_RUN_ID, spawn_id: 'spawn-abc', profile: 'explore' });
    expect(calls).toHaveLength(1);
    expect(calls[0].run_id).toBe(starts[0].run_id);
    expect(calls[0].logical_operation_id).toEqual(expect.any(String));
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ run_id: starts[0].run_id, reason: uncertain ? 'outcome_unknown' : 'completed',
      turns: uncertain ? 1 : 2, tool_calls: 1 });
  });
});
