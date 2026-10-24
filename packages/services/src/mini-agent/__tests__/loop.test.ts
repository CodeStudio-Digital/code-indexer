import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";
import { runMiniAgent } from '../loop.js';
import type { MiniDelta, MiniTool } from '../types.js';

/**
 * A scripted provider: each entry is the delta sequence for one chat() call,
 * consumed in order. Lets us drive the loop deterministically without a model.
 */
function scriptedProvider(turns: ChatDelta[][]): ChatProvider {
  let i = 0;
  return {
    name: 'scripted',
    model: 'test',
    setModel() {},
    async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
      const turn = turns[i++] ?? [{ type: 'done' }];
      for (const d of turn) yield d;
    },
  };
}

const echoTool: MiniTool = {
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  mutates: false,
  handler: async (a) => ({ content: `echo:${String((a as { text?: string }).text ?? '')}` }),
};

const deleteTool: MiniTool = {
  name: 'delete_thing',
  description: 'destructive',
  parameters: { type: 'object', properties: {} },
  mutates: true,
  handler: async () => ({ content: 'deleted' }),
};

async function collect(gen: AsyncGenerator<MiniDelta>): Promise<MiniDelta[]> {
  const out: MiniDelta[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

const userMsg = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go' }] }];

describe('runMiniAgent', () => {
  it('keeps streamed text contiguous in provider history without coalescing UI deltas', async () => {
    let turns = 0;
    const provider = scriptedProvider([]);
    provider.chat = async function* (request: ChatRequest): AsyncIterable<ChatDelta> {
      if (turns++ === 0) {
        for (let i = 0; i < 10_000; i++) yield { type: 'text_delta', text: 'x' };
        yield { type: 'tool_call_end', id: 'c1', name: 'echo', input: {} };
        yield { type: 'text_delta', text: 'after tool' };
      } else {
        const assistant = request.messages.find(message => message.role === 'assistant');
        expect(assistant?.content).toEqual([
          { type: 'text', text: 'x'.repeat(10_000) },
          { type: 'tool_use', id: 'c1', name: 'echo', input: {} },
          { type: 'text', text: 'after tool' },
        ]);
      }
      yield { type: 'done' };
    };
    const events = await collect(runMiniAgent({ provider, system: 's', tools: [echoTool], messages: userMsg }));
    expect(events.filter(event => event.type === 'text')).toHaveLength(10_001);
    expect(turns).toBe(2);
  });

  it('reports confirmation failure as a tool result without executing the mutation', async () => {
    const handler = vi.fn(async () => ({ content: 'effect' }));
    const events = await collect(runMiniAgent({
      provider: scriptedProvider([[{ type: 'tool_call_end', id: 'c1', name: 'delete_thing', input: {} }, { type: 'done' }]]),
      system: 's', tools: [{ ...deleteTool, handler }], messages: userMsg,
      confirm: async () => { throw new Error('confirmation connection closed'); },
    }));
    expect(handler).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: 'tool_result', callId: 'c1', name: 'delete_thing',
      content: 'confirmation connection closed', isError: true });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' });
  });
  it('does not execute a mutation after cancellation while approval was pending', async () => {
    const abort = new AbortController();
    const handler = vi.fn(async () => ({ content: 'deleted' }));
    let allow!: (value: boolean) => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const approval = new Promise<boolean>(resolve => { allow = resolve; });
    const result = collect(runMiniAgent({
      provider: scriptedProvider([[{ type: 'tool_call_end', id: 'c1', name: 'delete_thing', input: {} }, { type: 'done' }]]),
      system: 's', tools: [{ ...deleteTool, handler }], messages: userMsg, signal: abort.signal,
      confirm: async () => { entered(); return approval; },
    }));
    await waiting; abort.abort();
    const events = await result;
    allow(true); await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' });
    expect(events.some(e => e.type === 'tool_result' && e.isError && /cancelled/.test(e.content))).toBe(true);
  });

  it('does not start the handler when cancelled while publishing tool_use', async () => {
    const abort = new AbortController();
    const handler = vi.fn(async () => ({ content: 'effect' }));
    const events: MiniDelta[] = [];
    for await (const event of runMiniAgent({
      provider: scriptedProvider([[{ type: 'tool_call_end', id: 'c1', name: 'echo', input: {} }, { type: 'done' }]]),
      system: 's', tools: [{ ...echoTool, handler }], messages: userMsg, signal: abort.signal, maxSteps: 1,
    })) { events.push(event); if (event.type === 'tool_use') abort.abort(); }
    expect(handler).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' });
  });

  it('preserves an executed result but does not start the next call after cancellation', async () => {
    const abort = new AbortController();
    const handler = vi.fn(async () => { abort.abort(); return { content: 'effect finished' }; });
    const events = await collect(runMiniAgent({
      provider: scriptedProvider([[
        { type: 'tool_call_end', id: 'c1', name: 'echo', input: {} },
        { type: 'tool_call_end', id: 'c2', name: 'echo', input: {} }, { type: 'done' },
      ]]), system: 's', tools: [{ ...echoTool, handler }], messages: userMsg, signal: abort.signal, maxSteps: 1,
    }));
    expect(handler).toHaveBeenCalledOnce();
    expect(events).toContainEqual({ type: 'tool_result', callId: 'c1', name: 'echo', content: 'effect finished', isError: undefined });
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'stop' });
  });

  it('streams text then stops when the model makes no tool call', async () => {
    const provider = scriptedProvider([[{ type: 'text_delta', text: 'hello' }, { type: 'done' }]]);
    const deltas = await collect(runMiniAgent({ provider, system: 's', tools: [echoTool], messages: userMsg }));
    expect(deltas.filter((d) => d.type === 'text').map((d) => (d as { text: string }).text).join('')).toBe('hello');
    expect(deltas.at(-1)).toEqual({ type: 'done', reason: 'stop' });
  });

  it('runs a tool then loops back for the final answer', async () => {
    const provider = scriptedProvider([
      [{ type: 'tool_call_end', id: 'c1', name: 'echo', input: { text: 'hi' } }, { type: 'done' }],
      [{ type: 'text_delta', text: 'done!' }, { type: 'done' }],
    ]);
    const deltas = await collect(runMiniAgent({ provider, system: 's', tools: [echoTool], messages: userMsg }));
    const result = deltas.find((d) => d.type === 'tool_result') as { content: string };
    expect(result.content).toBe('echo:hi');
    expect(deltas.some((d) => d.type === 'text' && (d as { text: string }).text === 'done!')).toBe(true);
  });

  it('gates a mutating tool behind confirm; denial blocks execution', async () => {
    let ran = false;
    const tool: MiniTool = { ...deleteTool, handler: async () => { ran = true; return { content: 'deleted' }; } };
    const provider = scriptedProvider([
      [{ type: 'tool_call_end', id: 'c1', name: 'delete_thing', input: {} }, { type: 'done' }],
      [{ type: 'text_delta', text: 'ok' }, { type: 'done' }],
    ]);
    const deltas = await collect(
      runMiniAgent({ provider, system: 's', tools: [tool], messages: userMsg, confirm: async () => false }),
    );
    expect(deltas.some((d) => d.type === 'confirm_request')).toBe(true);
    expect(ran).toBe(false);
    const result = deltas.find((d) => d.type === 'tool_result') as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/denied/);
  });

  it('runs a mutating tool when confirm approves', async () => {
    let ran = false;
    const tool: MiniTool = { ...deleteTool, handler: async () => { ran = true; return { content: 'deleted' }; } };
    const provider = scriptedProvider([
      [{ type: 'tool_call_end', id: 'c1', name: 'delete_thing', input: {} }, { type: 'done' }],
      [{ type: 'done' }],
    ]);
    await collect(runMiniAgent({ provider, system: 's', tools: [tool], messages: userMsg, confirm: async () => true }));
    expect(ran).toBe(true);
  });

  it('reports unknown tool calls as errors (out-of-scope → no-op)', async () => {
    const provider = scriptedProvider([
      [{ type: 'tool_call_end', id: 'c1', name: 'rm_rf', input: {} }, { type: 'done' }],
      [{ type: 'done' }],
    ]);
    const deltas = await collect(runMiniAgent({ provider, system: 's', tools: [echoTool], messages: userMsg }));
    const result = deltas.find((d) => d.type === 'tool_result') as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/unknown tool/);
  });

  it('stops at maxSteps when the model never finishes', async () => {
    // Always calls a tool → never a no-tool turn → must hit the cap.
    const provider: ChatProvider = {
      name: 'loopy',
      model: 't',
      setModel() {},
      async *chat() {
        yield { type: 'tool_call_end', id: 'x', name: 'echo', input: { text: 'a' } };
        yield { type: 'done' };
      },
    };
    const deltas = await collect(
      runMiniAgent({ provider, system: 's', tools: [echoTool], messages: userMsg, maxSteps: 3 }),
    );
    expect(deltas.at(-1)).toEqual({ type: 'done', reason: 'max_steps' });
  });
});
