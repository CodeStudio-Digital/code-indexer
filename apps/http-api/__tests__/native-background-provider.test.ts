import { expect, it, vi } from 'vitest';
import type { ChatDelta } from '@mcp/provider-sdk';
import type { ChatProvider, ChatRequest } from '@mcp/provider-sdk/adapter.js';
import { withNativeBackgroundDrain } from '../workers/native-background-provider.js';

const request: ChatRequest = { system: '', messages: [], tools: [] };
function provider(deltas: ChatDelta[]): ChatProvider {
  return { name: 'selected', model: 'selected::model', setModel() { throw new Error('sealed'); }, async *chat() { yield* deltas; } };
}
it('streams text immediately but withholds final completion until owned jobs settle', async () => {
  let finish!: () => void;
  const drain = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const stream = withNativeBackgroundDrain(provider([{ type: 'text_delta', text: 'final' }, { type: 'done' }]), drain).chat(request)[Symbol.asyncIterator]();
  expect(await stream.next()).toMatchObject({ value: { text: 'final' } });
  let done = false; const pending = stream.next().then(value => { done = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(done).toBe(false); expect(drain).toHaveBeenCalledOnce();
  finish(); expect(await pending).toMatchObject({ value: { type: 'done' } });
});
it('allows tool rounds to continue while background jobs run and respects cancellation at final completion', async () => {
  const drain = vi.fn(async () => {});
  const call = withNativeBackgroundDrain(provider([{ type: 'tool_call_start', id: 'a', name: 'collect_agents' },
    { type: 'tool_call_end', id: 'a', name: 'collect_agents', input: {} }, { type: 'done' }]), drain);
  for await (const _delta of call.chat(request)) { /* consume */ }
  expect(drain).not.toHaveBeenCalled();
  const controller = new AbortController();
  const final = withNativeBackgroundDrain(provider([{ type: 'done' }]), () => new Promise<void>(() => {}));
  const pending = final.chat({ ...request, signal: controller.signal })[Symbol.asyncIterator]().next();
  controller.abort(new Error('cancelled'));
  await expect(pending).rejects.toThrow('cancelled');
});
it('surfaces unknown child settlement instead of publishing success', async () => {
  const stream = withNativeBackgroundDrain(provider([{ type: 'done' }]), async () => { throw new Error('unknown child'); });
  await expect(stream.chat(request)[Symbol.asyncIterator]().next()).rejects.toThrow('unknown child');
});

it('waits for existing children before exposing a workspace tool and does not double-wait on its result', async () => {
  let finish!: () => void;
  const drain = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const stream = withNativeBackgroundDrain(provider([
    { type: 'tool_call_start', id: 'read', name: 'read_file' },
    { type: 'tool_call_end', id: 'read', name: 'read_file', input: { path: 'seed.txt' } }, { type: 'done' },
  ]), drain).chat(request)[Symbol.asyncIterator]();
  let exposed = false; const pending = stream.next().then(result => { exposed = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(exposed).toBe(false);
  finish(); expect(await pending).toMatchObject({ value: { type: 'tool_call_start' } });
  expect(await stream.next()).toMatchObject({ value: { type: 'tool_call_end' } });
  expect(await stream.next()).toMatchObject({ value: { type: 'done' } }); expect(drain).toHaveBeenCalledOnce();
});

it('keeps all coordination calls available while a child runs and makes workspace waits cancelable', async () => {
  const drain = vi.fn(async () => {});
  for (const name of ['send_message', 'send_input', 'followup_task', 'collect_agents', 'list_agents', 'wait_agents']) {
    for await (const _delta of withNativeBackgroundDrain(provider([
      { type: 'tool_call_start', id: name, name }, { type: 'done' },
    ]), drain).chat(request)) { /* consume */ }
  }
  expect(drain).not.toHaveBeenCalled();
  const ctrl = new AbortController();
  const stream = withNativeBackgroundDrain(provider([{ type: 'tool_call_start', id: 'spawn', name: 'spawn_agent' }]),
    () => new Promise<void>(() => {})).chat({ ...request, signal: ctrl.signal })[Symbol.asyncIterator]();
  const pending = stream.next(); ctrl.abort(new Error('cancel workspace wait'));
  await expect(pending).rejects.toThrow('cancel workspace wait');
});
