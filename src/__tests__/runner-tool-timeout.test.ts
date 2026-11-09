import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";

/**
 * Tests for the per-call timeout / heartbeat / try-catch fallback added to
 * `CoderRunner` in commit 2 of the "stuck worker" fix.
 *
 * Goal: every `tool_call_start` emission MUST be followed by exactly one
 * `tool_call_result`, in finite time, even when the tool hangs, throws,
 * or some inner dispatch step crashes unexpectedly.
 *
 * Strategy: drive the runner with a one-shot provider stub that emits a
 * single tool_use on turn 1 then plain text on turn 2. Real timers + short
 * explicit `timeoutMs` keeps every test under ~300 ms with no flake.
 */

class SingleToolUseProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  private call = 0;
  setModel(m: string) { this.model = m; }
  constructor(
    private readonly toolName: string,
    private readonly input: Record<string, unknown> = {},
  ) {}
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    this.call++;
    if (this.call === 1) {
      yield { type: 'tool_call_end', id: 'call-1', name: this.toolName, input: this.input };
    } else {
      yield { type: 'text_delta', text: 'done' };
    }
    yield { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

function makeRunner(tools: CoderTool[], providerToolName: string, input: Record<string, unknown> = {}) {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  return new CoderRunner({
    provider: new SingleToolUseProvider(providerToolName, input),
    registry,
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  });
}

function captureResults(runner: CoderRunner) {
  const starts: string[] = [];
  const results: Array<{ id: string; isError?: boolean; content: string }> = [];
  const progress: Array<{ id: string; elapsedMs: number; note?: string }> = [];
  runner.on('tool_call_start', (id) => starts.push(id));
  runner.on('tool_call_result', (id, _name, r) =>
    results.push({ id, isError: r.isError, content: r.content }),
  );
  runner.on('tool_progress', (p) => progress.push({ id: p.id, elapsedMs: p.elapsedMs, note: p.note }));
  return { starts, results, progress };
}

describe('runner — universal tool timeout', () => {
  beforeEach(() => {
    delete process.env.MCP_TOOL_HEARTBEAT_MS;
    delete process.env.MCP_TOOL_NORMAL_TIMEOUT_MS;
    delete process.env.MCP_TOOL_SLOW_TIMEOUT_MS;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hanging tool with explicit short timeoutMs emits synthetic isError result', async () => {
    // Disable heartbeat so we don't get spammy events from the test.
    process.env.MCP_TOOL_HEARTBEAT_MS = '0';
    const hangingTool: CoderTool = {
      name: 'hangs',
      description: 'never returns',
      source: 'native',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 50,
      handler: () => new Promise(() => { /* never resolves */ }),
    };
    const runner = makeRunner([hangingTool], 'hangs');
    const { starts, results } = captureResults(runner);
    const res = await runner.run();

    expect(starts).toEqual(['call-1']);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toMatch(/`hangs` exceeded \d+ms/);
    const remainingMs = Number(results[0].content.match(/exceeded (\d+)ms/)?.[1]);
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(50);
    expect(res.reason).toBe('completed');
    // A recovered tool error does not become the terminal run transition.
    expect(res.transition).toBeNull();
  });

  it('explicit timeoutMs on the tool wins over the runner default', async () => {
    process.env.MCP_TOOL_HEARTBEAT_MS = '0';
    let observedTimeoutMs: number | undefined;
    const hangingTool: CoderTool = {
      name: 'slow',
      description: '',
      source: 'native',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 80,
      handler: () => new Promise(() => {}),
    };
    const runner = makeRunner([hangingTool], 'slow');
    runner.on('tool_call_result', (_id, _name, r) => {
      const m = r.content.match(/exceeded (\d+)ms/);
      if (m) observedTimeoutMs = Number(m[1]);
    });
    await runner.run();
    // The shared deadline includes dispatch/queue time. The handler receives
    // the remaining budget, which can be below 80ms even without contention.
    expect(observedTimeoutMs).toBeGreaterThan(0);
    expect(observedTimeoutMs).toBeLessThanOrEqual(80);
  });

  it('timeoutMs: Infinity opts out — runner does not race the handler', async () => {
    process.env.MCP_TOOL_HEARTBEAT_MS = '0';
    let handlerResolve: (v: { content: string }) => void = () => {};
    const longTool: CoderTool = {
      name: 'long',
      description: '',
      source: 'native',
      parameters: { type: 'object', properties: {} },
      timeoutMs: Infinity,
      handler: () => new Promise<{ content: string }>((resolve) => { handlerResolve = resolve; }),
    };
    const runner = makeRunner([longTool], 'long');
    const { results } = captureResults(runner);
    const runPromise = runner.run();
    // Give the runner some time — without Infinity opt-out it would time out
    // here. We resolve the handler manually to prove no synthetic result was
    // injected.
    await new Promise((r) => setTimeout(r, 30));
    expect(results).toHaveLength(0);
    handlerResolve({ content: 'manual resolve' });
    await runPromise;
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBeFalsy();
    expect(results[0].content).toBe('manual resolve');
  });

  it('per-call signal aborts when the timeout fires (cooperative tools can clean up)', async () => {
    process.env.MCP_TOOL_HEARTBEAT_MS = '0';
    let capturedSignal: AbortSignal | undefined;
    const observingTool: CoderTool = {
      name: 'observes',
      description: '',
      source: 'native',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 50,
      handler: async (_args, ctx) => {
        capturedSignal = ctx.signal;
        return new Promise(() => {}); // hang
      },
    };
    const runner = makeRunner([observingTool], 'observes');
    await runner.run();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });
});

describe('runner — tool_progress heartbeat', () => {
  beforeEach(() => {
    delete process.env.MCP_TOOL_HEARTBEAT_MS;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits periodic tool_progress while a tool is in flight', async () => {
    vi.useFakeTimers();
    const slowTool: CoderTool = {
      name: 'slow-but-cooperative',
      description: '',
      source: 'native',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 30_000,
      handler: () => new Promise((r) => setTimeout(() => r({ content: 'ok' }), 25_000)),
    };
    const runner = makeRunner([slowTool], 'slow-but-cooperative');
    const { progress, results } = captureResults(runner);
    const running = runner.run();
    await vi.advanceTimersByTimeAsync(25_000);
    await running;
    // Advance the real policy interval deterministically without wall-clock waits.
    expect(progress.length).toBeGreaterThanOrEqual(2);
    // elapsedMs is monotonically non-decreasing.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].elapsedMs).toBeGreaterThanOrEqual(progress[i - 1].elapsedMs);
    }
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBeFalsy();
  });

  it('ctx.reportProgress emits tool_progress with a trimmed note', async () => {
    process.env.MCP_TOOL_HEARTBEAT_MS = '0'; // suppress noisy heartbeats
    const longNote = 'x'.repeat(500);
    const reportingTool: CoderTool = {
      name: 'reports',
      description: '',
      source: 'native',
      parameters: { type: 'object', properties: {} },
      timeoutMs: 500,
      handler: async (_args, ctx) => {
        ctx.reportProgress?.(longNote);
        return { content: 'done' };
      },
    };
    const runner = makeRunner([reportingTool], 'reports');
    const { progress } = captureResults(runner);
    await runner.run();
    const withNote = progress.filter((p) => p.note !== undefined);
    expect(withNote).toHaveLength(1);
    expect(withNote[0].note).toBe('x'.repeat(200) + '...');
  });

  it('suppresses heartbeat when tool has timeoutMs: Infinity', async () => {
    process.env.MCP_TOOL_HEARTBEAT_MS = '15';
    let handlerResolve: (v: { content: string }) => void = () => {};
    const interactiveTool: CoderTool = {
      name: 'asks',
      description: '',
      source: 'native',
      parameters: { type: 'object', properties: {} },
      interactive: true, // resolves to Infinity via the classifier
      handler: () => new Promise<{ content: string }>((resolve) => { handlerResolve = resolve; }),
    };
    const runner = makeRunner([interactiveTool], 'asks');
    const { progress } = captureResults(runner);
    const runPromise = runner.run();
    await new Promise((r) => setTimeout(r, 60));
    expect(progress).toHaveLength(0);
    handlerResolve({ content: 'submitted' });
    await runPromise;
  });
});

describe('runner — try/catch fallback emits tool_call_result on dispatch crash', () => {
  beforeEach(() => {
    delete process.env.MCP_TOOL_HEARTBEAT_MS;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a handler that throws yields exactly one isError tool_call_result (covered by registry.invoke today; verify the contract still holds)', async () => {
    process.env.MCP_TOOL_HEARTBEAT_MS = '0';
    const throwingTool: CoderTool = {
      name: 'boom',
      description: '',
      source: 'native',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('synthetic handler crash');
      },
    };
    const runner = makeRunner([throwingTool], 'boom');
    const { starts, results } = captureResults(runner);
    await runner.run();
    expect(starts).toEqual(['call-1']);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toMatch(/synthetic handler crash/);
  });
});
