/**
 * The mini-agent tool loop. Streams the model's text, dispatches tool calls
 * against the passed tool map (mutating ones gated through `confirm`), appends
 * results, and repeats until the model stops or `maxSteps` is hit. Pure: takes
 * a provider + tools + system; emits MiniDelta. No god-file dependency.
 */
import type { AgentMessage, ContentBlock, ToolResultBlock } from "@mcp/provider-sdk";
import type { ToolSpec } from '@mcp/code-agent/providers/adapter.js';
import type { MiniDelta, MiniTool, RunMiniAgentOpts } from './types.js';

/** Approval has no tool effect to drain. Stop waiting on cancellation; a late
 * approval cannot revive this invocation. Always detach the abort listener. */
async function confirmCall(opts: RunMiniAgentOpts, call: PendingCall): Promise<boolean> {
  if (opts.signal?.aborted) return false;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<boolean>(resolve => {
    onAbort = () => resolve(false);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      opts.confirm!({ callId: call.id, name: call.name, input: call.input }), cancelled,
    ]);
  } finally {
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}

interface PendingCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One model turn: stream text deltas + collect any tool calls. */
async function* streamTurn(
  opts: RunMiniAgentOpts,
  specs: ToolSpec[],
  messages: AgentMessage[],
  assistant: ContentBlock[],
  calls: PendingCall[],
): AsyncGenerator<MiniDelta> {
  for await (const d of opts.provider.chat({
    system: opts.system,
    messages,
    tools: specs,
    signal: opts.signal,
  })) {
    if (d.type === 'text_delta') {
      const previous = assistant.at(-1);
      if (previous?.type === 'text') previous.text += d.text;
      else assistant.push({ type: 'text', text: d.text });
      yield { type: 'text', text: d.text };
    } else if (d.type === 'tool_call_end') {
      assistant.push({ type: 'tool_use', id: d.id, name: d.name, input: d.input });
      calls.push({ id: d.id, name: d.name, input: d.input });
    } else if (d.type === 'done') {
      break;
    }
  }
}

/** Run (or refuse) a single tool call, yielding the user-facing deltas. */
async function* runCall(
  call: PendingCall,
  tool: MiniTool | undefined,
  opts: RunMiniAgentOpts,
  results: ToolResultBlock[],
): AsyncGenerator<MiniDelta> {
  const emitResult = (content: string, isError?: boolean): MiniDelta => {
    results.push({ type: 'tool_result', tool_use_id: call.id, content, is_error: isError });
    return { type: 'tool_result', callId: call.id, name: call.name, content, isError };
  };

  if (!tool) {
    yield emitResult(`unknown tool: ${call.name}`, true);
    return;
  }
  yield { type: 'tool_use', callId: call.id, name: call.name, input: call.input };

  try {
    if (opts.signal?.aborted) {
      yield emitResult('cancelled before tool execution', true);
      return;
    }
    if (tool.mutates && opts.confirm) {
      yield { type: 'confirm_request', callId: call.id, name: call.name, input: call.input };
      const approved = await confirmCall(opts, call);
      if (opts.signal?.aborted) {
        yield emitResult('cancelled before tool execution', true);
        return;
      }
      if (!approved) {
        yield emitResult('denied by user', true);
        return;
      }
    }
    if (opts.signal?.aborted) {
      yield emitResult('cancelled before tool execution', true);
      return;
    }
    const r = await tool.handler(call.input);
    yield emitResult(r.content, r.isError);
  } catch (e) {
    yield emitResult(e instanceof Error ? e.message : String(e), true);
  }
}

export async function* runMiniAgent(opts: RunMiniAgentOpts): AsyncGenerator<MiniDelta> {
  const specs: ToolSpec[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as unknown as ToolSpec['parameters'],
  }));
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const messages: AgentMessage[] = [...opts.messages];
  const maxSteps = opts.maxSteps ?? 12;

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      yield { type: 'done', reason: 'stop' };
      return;
    }
    const assistant: ContentBlock[] = [];
    const calls: PendingCall[] = [];
    try {
      yield* streamTurn(opts, specs, messages, assistant, calls);
    } catch (e) {
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      return;
    }
    if (assistant.length) messages.push({ role: 'assistant', content: assistant });

    // No tool calls → the model answered; we're done.
    if (calls.length === 0) {
      yield { type: 'done', reason: 'stop' };
      return;
    }

    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      if (opts.signal?.aborted) {
        yield { type: 'done', reason: 'stop' };
        return;
      }
      // The assistant's tool_use block was already pushed during streaming.
      yield* runCall(call, byName.get(call.name), opts, results);
    }
    if (opts.signal?.aborted) {
      yield { type: 'done', reason: 'stop' };
      return;
    }
    messages.push({ role: 'tool', content: results });
  }
  yield { type: 'done', reason: 'max_steps' };
}
