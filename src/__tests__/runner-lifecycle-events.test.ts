import { describe, it, expect } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";

/**
 * Provider that emits a single text delta + done so we exercise exactly one
 * turn. The runner stops because there are no tool_use blocks.
 */
class TextOnlyProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'text_delta', text: 'hello' };
    yield { type: 'usage', usage: { input_tokens: 10, output_tokens: 2 } };
    yield { type: 'done' };
  }
}

/**
 * Provider that yields control back to the test before emitting `done`. Lets
 * us inspect the runner mid-stream — we resolve the gate to let it finish.
 */
class GatedProvider implements ChatProvider {
  readonly name = 'gated';
  model = 'gated-1';
  setModel(m: string) { this.model = m; }
  private gate = Promise.resolve();
  arm(): () => void {
    let release!: () => void;
    this.gate = new Promise<void>((res) => { release = res; });
    return release;
  }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'text_delta', text: 'in-progress' };
    await this.gate;
    yield { type: 'done' };
  }
}

function makeRunner(provider: ChatProvider): CoderRunner {
  const registry = new ToolRegistry();
  return new CoderRunner({
    provider,
    registry,
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
  });
}

describe('OpenRouter prompt cache accounting', () => {
  it.each([1, 2])('completes after %i tool rounds when every long prompt reports zero cached tokens', async (toolRounds) => {
    const inputTokens = 114_807;
    let calls = 0;
    const provider: ChatProvider = {
      name: 'openrouter', model: 'test-model', setModel() {},
      async *chat(): AsyncIterable<ChatDelta> {
        const page = ++calls;
        if (page <= toolRounds) {
          yield { type: 'tool_call_end', id: 'read-' + page, name: 'read_note', input: { page } };
        } else {
          yield { type: 'text_delta', text: 'All pages read.' };
        }
        yield { type: 'usage', usage: { input_tokens: inputTokens, output_tokens: 3,
          prompt_tokens_total: inputTokens, cache_read_input_tokens: 0 } };
        yield { type: 'done' };
      },
    };
    const pages: number[] = [];
    const registry = new ToolRegistry();
    registry.register({ name: 'read_note', description: 'Read a page', source: 'native',
      parameters: { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] },
      handler: async ({ page }) => { pages.push(Number(page)); return { content: 'Page ' + page }; } });
    const runner = new CoderRunner({ provider, registry, contextWindow: 1_000_000, systemPrompt: 'sys',
      toolContext: { cwd: '/tmp', projectName: 'test' },
      initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'Read the requested pages.' }] }] });
    const terminalEvents: string[] = [];
    runner.on('done', reason => terminalEvents.push(reason));
    const result = await runner.run();
    expect(result.reason).toBe('completed');
    expect(terminalEvents).toEqual(['completed']);
    expect(pages).toEqual(toolRounds === 1 ? [1] : [1, 2]);
    expect(calls).toBe(toolRounds + 1);
    expect(result.totalUsage).toMatchObject({ input_tokens: inputTokens * calls, output_tokens: 3 * calls, cache_read_input_tokens: 0 });
    expect(runner.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'All pages read.' });
  });
});

describe('runner lifecycle events', () => {
  it('emits run_started with a stable runId before any turn_start', async () => {
    const r = makeRunner(new TextOnlyProvider());
    const events: string[] = [];
    let runStartedRunId: string | null = null;
    let runId: string | null = null;
    r.on('run_started', (p) => {
      runStartedRunId = p.runId;
      events.push('run_started');
    });
    r.on('turn_start', () => events.push('turn_start'));
    r.on('done', () => events.push('done'));
    runId = r.runId;
    await r.run();
    expect(runStartedRunId).toBe(runId);
    expect(events[0]).toBe('run_started');
    expect(events.indexOf('turn_start')).toBeGreaterThan(events.indexOf('run_started'));
    expect(events[events.length - 1]).toBe('done');
  });

  it('emits provider_call once per turn with consistent runId', async () => {
    const r = makeRunner(new TextOnlyProvider());
    const calls: Array<{ runId: string; turn: number; toolCount: number }> = [];
    r.on('provider_call', (p) => calls.push({ runId: p.runId, turn: p.turn, toolCount: p.toolCount }));
    await r.run();
    expect(calls).toHaveLength(1);
    expect(calls[0].turn).toBe(1);
    expect(calls[0].runId).toBe(r.runId);
    expect(calls[0].toolCount).toBe(0); // empty registry
  });

  it('emits tool_batch with empty names when assistant returns no tool calls', async () => {
    const r = makeRunner(new TextOnlyProvider());
    const batches: Array<{ count: number; names: string[] }> = [];
    r.on('tool_batch', (p) => batches.push({ count: p.count, names: p.names }));
    await r.run();
    expect(batches).toHaveLength(1);
    expect(batches[0].count).toBe(0);
    expect(batches[0].names).toEqual([]);
  });
});

describe('runner enqueue + interrupt primitives', () => {
  it('pushUserMessage completes the current turn and consumes the queued text on the next turn', async () => {
    const provider = new GatedProvider();
    const release = provider.arm();
    const r = makeRunner(provider);

    const events: string[] = [];
    r.on('text_delta', () => events.push('text_delta'));
    r.on('done', () => events.push('done'));

    const finished = r.run();

    // Push a message while the provider is mid-stream. It must NOT cause an
    // interruption — pushUserMessage is a buffer, not a signal.
    await new Promise((res) => setTimeout(res, 10));
    r.pushUserMessage('change of plan');
    expect(r.isWaitingForInput()).toBe(false);

    release();
    const result = await finished;
    expect(result.reason).toBe('completed');
    expect(events).toContain('text_delta');
    expect(events).toContain('done');

    // Queued input starts a subsequent turn after the active stream completes.
    const userTexts = r.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text);
    expect(userTexts).toContain('go');
    expect(userTexts).toContain('change of plan');
    expect(userTexts).toHaveLength(2);
  });

  it('interruptWait resolves a pending wait with { interrupted: true }', async () => {
    const r = makeRunner(new TextOnlyProvider());
    const waiter = r.waitForUserInput();
    expect(r.isWaitingForInput()).toBe(true);
    expect(r.interruptWait()).toBe(true);
    expect(r.isWaitingForInput()).toBe(false);
    const value = await waiter;
    expect(JSON.parse(value)).toEqual({ interrupted: true });
    // Idempotent: a second call with no pending wait returns false.
    expect(r.interruptWait()).toBe(false);
  });
});
