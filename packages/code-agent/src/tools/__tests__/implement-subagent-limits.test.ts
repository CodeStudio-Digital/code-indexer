import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import { runParallelAgents, runSubagent } from '../implement-subagent.js';

function tool(name = 'mock_tool'): CoderTool {
  return {
    name,
    description: 'mock tool',
    parameters: { type: 'object', properties: {} },
    source: 'native',
    handler: async () => ({ content: 'ok' }),
  };
}

function parent(provider: ChatProvider, tools: CoderTool[] = [tool()]) {
  return {
    provider,
    tools,
    ctx: {
      cwd: process.cwd(),
      projectName: 'test',
    } as ToolContext,
  };
}

function toolCallingProvider(): ChatProvider {
  let call = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      call++;
      yield { type: 'tool_call_start', id: `tu_${call}`, name: 'mock_tool' };
      yield { type: 'tool_call_end', id: `tu_${call}`, name: 'mock_tool', input: {} };
      yield { type: 'done', stop_reason: 'tool_use' };
    },
  };
}

function hangingProvider(): ChatProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      await new Promise(() => {
        /* never resolves */
      });
    },
  };
}

/**
 * Calls `mock_tool` for the first `toolCallsBeforeDone` turns, then finishes
 * naturally (text + end_turn, no tool_use). Lets a test drive several tool
 * calls and still complete on its own — used to prove an uncapped subagent
 * isn't killed by the tool-call watchdog.
 */
function finishingProvider(toolCallsBeforeDone: number): ChatProvider {
  let call = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      call++;
      if (call > toolCallsBeforeDone) {
        yield { type: 'text_delta', text: 'done exploring' };
        yield { type: 'done', stop_reason: 'end_turn' };
        return;
      }
      yield { type: 'tool_call_start', id: `tu_${call}`, name: 'mock_tool' };
      yield { type: 'tool_call_end', id: `tu_${call}`, name: 'mock_tool', input: { call } };
      yield { type: 'done', stop_reason: 'tool_use' };
    },
  };
}

function budgetedProviderWithUsage(): ChatProvider {
  let call = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      call++;
      if (call === 1) {
        yield {
          type: 'usage',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 5,
          },
        };
        yield { type: 'tool_call_start', id: 'tu_1', name: 'mock_tool' };
        yield { type: 'tool_call_end', id: 'tu_1', name: 'mock_tool', input: {} };
        yield { type: 'done', stop_reason: 'tool_use' };
        return;
      }
      yield { type: 'usage', usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 } };
      yield { type: 'text_delta', text: 'salvaged findings' };
      yield { type: 'done', stop_reason: 'end_turn' };
    },
  };
}

function completingProviderWithUsage(): ChatProvider {
  return {
    name: 'mock',
    model: 'mock-model',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      yield {
        type: 'usage',
        usage: {
          input_tokens: 11,
          output_tokens: 4,
          cache_read_input_tokens: 6,
          cache_creation_input_tokens: 2,
        },
      };
      yield { type: 'text_delta', text: 'complete' };
      yield { type: 'done', stop_reason: 'end_turn' };
    },
  };
}

describe('runSubagent limits', () => {
  beforeEach(() => {
    process.env.CODER_SUBAGENT_SALVAGE_TIMEOUT_MS = '20';
  });

  afterEach(() => {
    delete process.env.CODER_SUBAGENT_SALVAGE_TIMEOUT_MS;
    delete process.env.CODER_SUBAGENT_SAME_OPERATION_MAX;
  });

  it('reports tool_budget (not error) when the tool-call cap is reached', async () => {
    const progress: string[] = [];
    const result = await runSubagent(parent(toolCallingProvider()), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'call tools' }] }],
      maxTurns: 10,
      limits: { maxToolCalls: 1, timeoutMs: 5_000, stallMs: 5_000 },
      onProgress: (p) => {
        if (p.note) progress.push(p.note);
      },
    });

    expect(result.reason).toBe('tool_budget');
    expect(result.finalText).toContain('task tool limit reached');
    expect(progress.some((note) => note.includes('task tool limit reached'))).toBe(true);
  });

  it('returns an error result when the subagent stalls', async () => {
    const result = await runSubagent(parent(hangingProvider(), []), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'hang' }] }],
      maxTurns: 10,
      limits: { timeoutMs: 5_000, stallMs: 20 },
    });

    expect(result.reason).toBe('error');
    expect(result.finalText).toContain('subagent stalled');
  });

  it('does not cap tool calls when maxToolCalls is 0 (codex-style, unlimited)', async () => {
    const result = await runSubagent(parent(finishingProvider(4)), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'explore' }] }],
      maxTurns: 10,
      limits: { maxToolCalls: 0, timeoutMs: 5_000, stallMs: 5_000 },
    });

    // With the cap disabled the watchdog must NOT kill the run on a call
    // budget: it completes naturally after its tool calls instead.
    expect(result.reason).not.toBe('tool_budget');
    expect(result.reason).not.toBe('error');
    expect(result.finalText).not.toContain('task tool limit reached');
  });

  it('stops an unlimited subagent that repeats one stable operation without progress', async () => {
    process.env.CODER_SUBAGENT_SAME_OPERATION_MAX = '3';
    const progress: string[] = [];
    const result = await runSubagent(parent(toolCallingProvider()), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'repeat forever' }] }],
      maxTurns: 0,
      limits: { maxToolCalls: 0, timeoutMs: 0, stallMs: 5_000 },
      onProgress: (event) => {
        if (event.note) progress.push(event.note);
      },
    });

    expect(result.reason).toBe('error');
    expect(result.failureDetail).toContain('subagent_convergence_watchdog');
    expect(progress.some((note) => note.includes('made no progress 3 consecutive times'))).toBe(true);
  });

  it('nudges synthesis after a soft target without cutting the run or marking it partial', async () => {
    const systemPrompts: string[] = [];
    let call = 0;
    const provider: ChatProvider = {
      name: 'mock',
      model: 'mock-model',
      setModel() {},
      async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
        systemPrompts.push(request.system);
        call++;
        if (call === 1) {
          yield { type: 'tool_call_start', id: 'tu_soft', name: 'mock_tool' };
          yield { type: 'tool_call_end', id: 'tu_soft', name: 'mock_tool', input: {} };
          yield { type: 'done', stop_reason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'evidence-backed summary' };
        yield { type: 'done', stop_reason: 'end_turn' };
      },
    };
    const phases: string[] = [];
    const result = await runSubagent(parent(provider), {
      systemPrompt: 'You are a test investigator.',
      profile: 'explore',
      researchPolicy: {
        depth: 'quick',
        source: 'explicit',
        softToolTarget: 1,
        softTimeTargetMs: 0,
        completionCriteria: ['Answer the delegated question'],
      },
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'inspect once' }] }],
      maxTurns: 0,
      limits: { maxToolCalls: 0, timeoutMs: 0, stallMs: 5_000 },
      onProgress: (progress) => {
        if (progress.phase) phases.push(progress.phase);
      },
    });

    expect(result.reason).toBe('completed');
    expect(result.finalText).toContain('evidence-backed summary');
    expect(systemPrompts[0]).not.toContain('SYNTHESIS CHECKPOINT');
    expect(systemPrompts[1]).toContain('SYNTHESIS CHECKPOINT');
    expect(phases).toContain('synthesis_nudge');
  });

  it('injects the hard-budget warning once at 80% of the tool cap and still completes', async () => {
    const systemPrompts: string[] = [];
    let call = 0;
    const provider: ChatProvider = {
      name: 'mock',
      model: 'mock-model',
      setModel() {},
      async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
        systemPrompts.push(request.system);
        call++;
        if (call > 4) {
          yield { type: 'text_delta', text: 'final findings' };
          yield { type: 'done', stop_reason: 'end_turn' };
          return;
        }
        yield { type: 'tool_call_start', id: `tu_${call}`, name: 'mock_tool' };
        yield { type: 'tool_call_end', id: `tu_${call}`, name: 'mock_tool', input: { call } };
        yield { type: 'done', stop_reason: 'tool_use' };
      },
    };
    const phases: string[] = [];
    const result = await runSubagent(parent(provider), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'inspect' }] }],
      maxTurns: 0,
      // 80% of 5 = ceil(4) → the warning lands on the turn AFTER the 4th call.
      limits: { maxToolCalls: 5, timeoutMs: 0, stallMs: 5_000 },
      onProgress: (progress) => {
        if (progress.phase) phases.push(progress.phase);
      },
    });

    expect(result.reason).toBe('completed');
    expect(result.finalText).toContain('final findings');
    const warned = systemPrompts.map((p) => p.includes('HARD BUDGET WARNING'));
    expect(warned.slice(0, 4)).toEqual([false, false, false, false]);
    expect(warned[4]).toBe(true);
    expect(phases).toContain('budget_nudge');
  });

  it('cuts a warned run at the cap as tool_budget (nudge does not replace the guard)', async () => {
    const systemPrompts: string[] = [];
    let call = 0;
    const provider: ChatProvider = {
      name: 'mock',
      model: 'mock-model',
      setModel() {},
      async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
        systemPrompts.push(request.system);
        call++;
        yield { type: 'tool_call_start', id: `tu_${call}`, name: 'mock_tool' };
        yield { type: 'tool_call_end', id: `tu_${call}`, name: 'mock_tool', input: { call } };
        yield { type: 'done', stop_reason: 'tool_use' };
      },
    };
    const result = await runSubagent(parent(provider), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'never stop' }] }],
      maxTurns: 0,
      limits: { maxToolCalls: 5, timeoutMs: 0, stallMs: 5_000 },
    });

    expect(result.reason).toBe('tool_budget');
    expect(result.finalText).toContain('task tool limit reached');
    expect(systemPrompts.filter((p) => p.includes('HARD BUDGET WARNING'))).toHaveLength(1);
  });

  it('never injects the hard-budget warning when both caps are 0', async () => {
    const systemPrompts: string[] = [];
    let call = 0;
    const provider: ChatProvider = {
      name: 'mock',
      model: 'mock-model',
      setModel() {},
      async *chat(request: ChatRequest): AsyncIterable<ChatDelta> {
        systemPrompts.push(request.system);
        call++;
        if (call > 4) {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'done', stop_reason: 'end_turn' };
          return;
        }
        yield { type: 'tool_call_start', id: `tu_${call}`, name: 'mock_tool' };
        yield { type: 'tool_call_end', id: `tu_${call}`, name: 'mock_tool', input: { call } };
        yield { type: 'done', stop_reason: 'tool_use' };
      },
    };
    const result = await runSubagent(parent(provider), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'explore' }] }],
      maxTurns: 0,
      limits: { maxToolCalls: 0, timeoutMs: 0, stallMs: 5_000 },
    });

    expect(result.reason).toBe('completed');
    expect(systemPrompts.every((p) => !p.includes('HARD BUDGET WARNING'))).toBe(true);
  });

  it('runs past 100 turns when turn/tool/time caps are zero', async () => {
    const result = await runSubagent(parent(finishingProvider(105)), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'keep exploring' }] }],
      maxTurns: 0,
      limits: { maxToolCalls: 0, timeoutMs: 0, stallMs: 5_000 },
    });

    expect(result.reason).toBe('completed');
    expect(result.finalText).toContain('done exploring');
  });

  it('classifies an explicit hard timeout as a resumable time budget', async () => {
    const result = await runSubagent(parent(hangingProvider(), []), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'hang' }] }],
      maxTurns: 0,
      limits: { maxToolCalls: 0, timeoutMs: 20, stallMs: 5_000 },
    });

    expect(result.reason).toBe('time_budget');
    expect(result.finalText).toContain('subagent hard timeout reached');
  });

  it('keeps prior turn usage and adds salvage usage after a budget cutoff', async () => {
    const result = await runSubagent(parent(budgetedProviderWithUsage()), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'inspect once' }] }],
      maxTurns: 0,
      limits: { maxToolCalls: 1, timeoutMs: 0, stallMs: 5_000 },
    });

    expect(result.reason).toBe('tool_budget');
    expect(result.usage).toMatchObject({
      input_tokens: 107,
      output_tokens: 13,
      cache_read_input_tokens: 42,
      cache_creation_input_tokens: 5,
    });
  });

  it('uses the runner total exactly once on normal completion', async () => {
    const result = await runSubagent(parent(completingProviderWithUsage()), {
      systemPrompt: 'You are a test subagent.',
      allowlist: null,
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'finish' }] }],
      maxTurns: 0,
      limits: { maxToolCalls: 0, timeoutMs: 0, stallMs: 5_000 },
    });

    expect(result.reason).toBe('completed');
    expect(result.usage).toMatchObject({
      input_tokens: 11,
      output_tokens: 4,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 2,
    });
  });

  it('surfaces an operational cutoff as partial in parallel progress', async () => {
    const terminal: string[] = [];
    const { results } = await runParallelAgents(
      parent(hangingProvider(), []),
      [{
        task: 'wait', label: 'waiter', maxTurns: 0,
        limits: { maxToolCalls: 0, timeoutMs: 20, stallMs: 5_000 },
      }],
      'You are a test subagent.',
      null,
      (progress) => {
        if (progress.status) terminal.push(progress.status);
      },
    );

    expect(results[0].reason).toBe('time_budget');
    expect(terminal.at(-1)).toBe('partial');
  });

  it('lets six progressing agents complete with concurrency five and no global caps', async () => {
    const statuses: string[] = [];
    const specs = Array.from({ length: 6 }, (_, index) => ({
      task: `task ${index}`,
      label: `agent ${index}`,
      maxTurns: 0,
      provider: finishingProvider(2),
      limits: { maxToolCalls: 0, timeoutMs: 0, stallMs: 5_000 },
    }));
    const { results } = await runParallelAgents(
      parent(finishingProvider(0)),
      specs,
      'You are a test subagent.',
      null,
      (progress) => {
        if (progress.event === 'completed' || progress.event === 'partial'
          || progress.event === 'error' || progress.event === 'timed_out') {
          statuses.push(progress.event);
        }
      },
      5,
    );

    expect(results).toHaveLength(6);
    expect(results.every((result) => result.reason === 'completed')).toBe(true);
    expect(statuses).toEqual(Array(6).fill('completed'));
  });
});
