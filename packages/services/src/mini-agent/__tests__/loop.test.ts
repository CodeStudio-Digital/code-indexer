import { describe, expect, it } from 'vitest';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
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
