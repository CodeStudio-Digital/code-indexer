import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { SUBAGENT_TOOL_RESULT_CAP, type CoderRunner } from '@mcp/code-agent/core/runner.js';
import { HookBus } from '@mcp/code-agent/core/hook-bus.js';
import {
  runSubagent,
  wrapProviderForSubagentFence,
  wrapToolForSubagentFence,
} from '../implement-subagent.js';

describe('subagent execution fencing', () => {
  let previousEnforce: string | undefined;
  let previousShadow: string | undefined;

  beforeEach(() => {
    previousEnforce = process.env.CODER_AGENT_RUN_STORE_ENFORCE;
    previousShadow = process.env.CODER_AGENT_RUN_STORE_SHADOW;
    delete process.env.CODER_AGENT_RUN_STORE_ENFORCE;
    delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
  });

  afterEach(() => {
    if (previousEnforce === undefined) delete process.env.CODER_AGENT_RUN_STORE_ENFORCE;
    else process.env.CODER_AGENT_RUN_STORE_ENFORCE = previousEnforce;
    if (previousShadow === undefined) delete process.env.CODER_AGENT_RUN_STORE_SHADOW;
    else process.env.CODER_AGENT_RUN_STORE_SHADOW = previousShadow;
  });

  it('checks the lease at first provider iteration, before the physical adapter starts', async () => {
    let valid = true;
    let physicalCalls = 0;
    const provider: ChatProvider = {
      name: 'fake',
      model: 'fake-model',
      setModel(model) { this.model = model; },
      async *chat() {
        physicalCalls += 1;
      },
    };
    const fenced = wrapProviderForSubagentFence(provider, () => {
      if (!valid) throw new Error('fenced provider');
    });

    const iterable = fenced.chat({
      system: '',
      messages: [],
      tools: [],
    });
    valid = false;
    const consume = async (): Promise<void> => {
      for await (const _delta of iterable) {
        // no-op
      }
    };
    await expect(consume()).rejects.toThrow('fenced provider');
    expect(physicalCalls).toBe(0);
  });

  it('withholds provider deltas when the lease is fenced while the request is in flight', async () => {
    let valid = true;
    const observed: string[] = [];
    const provider: ChatProvider = {
      name: 'fake',
      model: 'fake-model',
      setModel(model) { this.model = model; },
      async *chat() {
        valid = false;
        yield { type: 'text_delta' as const, text: 'stale result' };
      },
    };
    const fenced = wrapProviderForSubagentFence(provider, () => {
      if (!valid) throw new Error('fenced provider ACK');
    });

    const consume = async (): Promise<void> => {
      for await (const delta of fenced.chat({ system: '', messages: [], tools: [] })) {
        if (delta.type === 'text_delta') observed.push(delta.text);
      }
    };
    await expect(consume()).rejects.toThrow('fenced provider ACK');
    expect(observed).toEqual([]);
  });

  it('blocks a mutating tool and post-registry record_memo before its handler side effect', async () => {
    for (const name of ['write_file', 'record_memo']) {
      let sideEffects = 0;
      const tool: CoderTool = {
        name,
        description: name,
        parameters: { type: 'object', properties: {} },
        source: 'native',
        mutates: name === 'write_file',
        handler: async () => {
          sideEffects += 1;
          return { content: 'changed' };
        },
      };
      const fenced = wrapToolForSubagentFence(tool, () => {
        throw new Error(`fenced ${name}`);
      });

      await expect(fenced.handler({}, {} as never)).rejects.toThrow(`fenced ${name}`);
      expect(sideEffects).toBe(0);
    }
  });

  it('withholds a mutating tool result when the lease changes during its handler', async () => {
    let valid = true;
    let sideEffects = 0;
    const tool: CoderTool = {
      name: 'write_file',
      description: 'write',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      mutates: true,
      handler: async () => {
        sideEffects += 1;
        valid = false;
        return { content: 'stale result' };
      },
    };
    const fenced = wrapToolForSubagentFence(tool, () => {
      if (!valid) throw new Error('fenced tool ACK');
    });

    await expect(fenced.handler({}, {} as never)).rejects.toThrow('fenced tool ACK');
    expect(sideEffects).toBe(1);
  });

  it('aborts before any provider call when enforced fence creation fails', async () => {
    process.env.CODER_AGENT_RUN_STORE_ENFORCE = '1';
    let physicalCalls = 0;
    const provider: ChatProvider = {
      name: 'fake',
      model: 'fake-model',
      setModel(model) { this.model = model; },
      async *chat() {
        physicalCalls += 1;
      },
    };
    const startSubagentRun = vi.fn(() => {
      throw new Error('durable fence unavailable');
    });

    await expect(runSubagent({
      provider,
      tools: [],
      ctx: {
        cwd: process.cwd(),
        projectName: 'test',
        controlPlaneParentAgentRunId: 'agent-run:root',
      } as ToolContext,
      sessionId: 42,
      sessionStore: { startSubagentRun } as never,
    }, {
      systemPrompt: 'test',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'run' }] }],
      maxTurns: 1,
    })).rejects.toThrow('durable fence unavailable');

    expect(startSubagentRun).toHaveBeenCalledOnce();
    expect(physicalCalls).toBe(0);
  });

  it('propagates the root HookBus so real child lifecycle stages are ordered on the same bus', async () => {
    const stages: string[] = [];
    const hookBus = new HookBus();
    for (const stage of ['agent_spawned', 'agent_terminal'] as const) {
      hookBus.register({
        hookId: `test:${stage}`,
        version: '1',
        kind: 'observation',
        stage,
        source: 'system',
        trustLevel: 'trusted_process',
        timeoutMs: 1_000,
        priority: 0,
        failurePolicy: 'open',
        idempotency: 'none',
        redactionPolicyRef: 'test',
        handler: () => { stages.push(stage); },
      });
    }
    const provider: ChatProvider = {
      name: 'fake',
      model: 'fake-model',
      setModel(model) { this.model = model; },
      async *chat() {
        yield { type: 'text_delta' as const, text: 'done' };
        yield { type: 'done' as const, stop_reason: 'end_turn' as const };
      },
    };
    const parentRunner = {
      runId: 'root-run',
      emit: vi.fn(),
      getHookBus: () => hookBus,
      getReasoningEffort: () => undefined,
      getToolSelectionFilter: () => undefined,
      getExternalToolTiers: () => undefined,
    } as unknown as CoderRunner;

    const result = await runSubagent({
      provider,
      tools: [],
      ctx: {
        cwd: process.cwd(),
        projectName: 'test',
        runner: parentRunner,
      } as ToolContext,
    }, {
      systemPrompt: 'test',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'run' }] }],
      maxTurns: 1,
    });

    expect(result.reason).toBe('completed');
    expect(stages).toEqual(['agent_spawned', 'agent_terminal']);
  });

  it('composes foreground and background children with child-local policy before mutation', async () => {
    const scoped: Array<{
      background: boolean;
      taskScope: { id: string; files: string[] } | null;
      agentRunId?: string;
    }> = [];
    let sideEffects = 0;
    const writeTool: CoderTool = {
      name: 'write_file',
      description: 'write',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      mutates: true,
      riskLevel: 'write',
      handler: async () => {
        sideEffects += 1;
        return { content: 'changed' };
      },
    };
    const parentRunner = {
      runId: 'root-run',
      emit: vi.fn(),
      getHookBus: () => undefined,
      getReasoningEffort: () => undefined,
      getToolSelectionFilter: () => undefined,
      getExternalToolTiers: () => undefined,
      getPolicyShadowScopeFactory: () => (sessionContext: {
        background: boolean;
        getLegacyContext: () => {
          taskScope: { id: string; files: string[] } | null;
        };
        getAgentRunId?: () => string | undefined;
      }) => async () => {
        scoped.push({
          background: sessionContext.background,
          taskScope: sessionContext.getLegacyContext().taskScope,
          agentRunId: sessionContext.getAgentRunId?.(),
        });
        return { refuse: true as const, refusalText: '[policy-engine: denied]' };
      },
    } as unknown as CoderRunner;

    for (const waitMode of ['foreground', 'background'] as const) {
      let calls = 0;
      const provider: ChatProvider = {
        name: 'fake',
        model: 'fake-model',
        setModel(model) { this.model = model; },
        async *chat() {
          calls += 1;
          if (calls === 1) {
            yield { type: 'tool_call_start' as const, id: `tu-${waitMode}`, name: 'write_file' };
            yield {
              type: 'tool_call_end' as const,
              id: `tu-${waitMode}`,
              name: 'write_file',
              input: { path: 'child.ts' },
            };
            yield { type: 'done' as const, stop_reason: 'tool_use' as const };
            return;
          }
          yield { type: 'text_delta' as const, text: 'policy observed' };
          yield { type: 'done' as const, stop_reason: 'end_turn' as const };
        },
      };
      const result = await runSubagent({
        provider,
        tools: [writeTool],
        ctx: {
          cwd: process.cwd(),
          projectName: 'test',
          runner: parentRunner,
        } as ToolContext,
        sessionId: 42,
      }, {
        systemPrompt: 'test',
        allowlist: null,
        initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'run' }] }],
        maxTurns: 3,
        waitMode,
        spawnId: `spawn-${waitMode}`,
        pathScope: ['child.ts'],
      });
      expect(result.reason).toBe('completed');
    }

    expect(sideEffects).toBe(0);
    expect(scoped.map(({ background, taskScope }) => ({ background, taskScope }))).toEqual([
      {
        background: false,
        taskScope: { id: 'spawn-foreground', files: ['child.ts'] },
      },
      {
        background: true,
        taskScope: { id: 'spawn-background', files: ['child.ts'] },
      },
    ]);
    expect(scoped.every((entry) => entry.agentRunId?.startsWith('agent-run:subagent:'))).toBe(true);
  });

  it('reasserts the child fence after deterministic output spill and before terminal commit', async () => {
    process.env.CODER_AGENT_RUN_STORE_SHADOW = '1';
    let owned = true;
    const fence = {
      sessionId: 'session:test',
      legacySessionId: 42,
      commandId: 'command:test',
      correlationId: 'correlation:test',
      actor: { actorId: 'test', actorType: 'system', source: 'runtime' },
      agentRunId: 'agent-run:child',
      attemptId: 'attempt:child',
      executorOwnerId: 'worker:test',
      fencingEpoch: 1,
    };
    const completeSubagentRun = vi.fn();
    const assertSubagentRunFence = vi.fn(() => {
      if (!owned) throw new Error('fenced after output spill');
    });
    const put = vi.fn(() => {
      owned = false;
      return 'deadbeefcafe';
    });
    const provider: ChatProvider = {
      name: 'fake',
      model: 'fake-model',
      setModel(model) { this.model = model; },
      async *chat() {
        yield {
          type: 'text_delta' as const,
          text: 'x'.repeat(SUBAGENT_TOOL_RESULT_CAP + 1),
        };
        yield { type: 'done' as const, stop_reason: 'end_turn' as const };
      },
    };

    await expect(runSubagent({
      provider,
      tools: [],
      ctx: {
        cwd: process.cwd(),
        projectName: 'test',
        toolOutputStore: { put } as never,
      } as ToolContext,
      sessionId: 42,
      sessionStore: {
        startSubagentRun: vi.fn(() => fence),
        assertSubagentRunFence,
        completeSubagentRun,
      } as never,
    }, {
      systemPrompt: 'test',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'run' }] }],
      maxTurns: 1,
    })).rejects.toThrow('fenced after output spill');

    expect(put).toHaveBeenCalledOnce();
    expect(assertSubagentRunFence).toHaveBeenCalled();
    expect(completeSubagentRun).not.toHaveBeenCalled();
  });
});
