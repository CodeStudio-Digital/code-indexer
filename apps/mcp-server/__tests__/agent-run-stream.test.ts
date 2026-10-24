import { expect, it, vi } from 'vitest';
import { AgentStreamInterruptedError, readMcpAgentTerminal } from '../agent-run-stream.js';

function response(chunks: Uint8Array[]) {
  const cancel = vi.fn();
  let index = 0;
  const value = new Response(new ReadableStream({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); }, cancel,
  }));
  const text = vi.spyOn(value, 'text').mockRejectedValue(new Error('Full stream buffering is forbidden'));
  return { value, cancel, text };
}
const encode = (text: string) => new TextEncoder().encode(text);

it('drains a long progress stream with bounded retention and preserves the terminal classification', async () => {
  let progress = 0;
  const cancel = vi.fn();
  const chunk = encode(`event: text\ndata: ${JSON.stringify({ text: 'x'.repeat(20_000) })}\n\n`);
  const value = new Response(new ReadableStream({ pull(controller) {
    controller.enqueue(progress++ < 600 ? chunk : encode('event: done\ndata: {"reason":"max_turns"}\n\n'));
  }, cancel }));
  expect(await readMcpAgentTerminal(value, new AbortController().signal)).toMatchObject({ classification: 'interrupted', reason: 'max_turns' });
  expect(progress).toBeGreaterThanOrEqual(601);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each([
  ['done', 'completed', 'completed'], ['done', 'aborted', 'cancelled'],
  ['done', 'ipc_identity_budget', 'interrupted'], ['done', 'provider_failure', 'failed'], ['error', 'completed', 'failed'],
])('classifies %s/%s as %s across CRLF and split UTF-8', async (event, reason, classification) => {
  const wire = encode(`: heartbeat\r\n\r\nevent: text\r\ndata: {"text":"ação"}\r\n\r\nevent: ${event}\r\ndata: ${JSON.stringify({ reason })}\r\n\r\n`);
  const f = response(Array.from(wire, byte => Uint8Array.of(byte)));
  expect(await readMcpAgentTerminal(f.value, new AbortController().signal)).toMatchObject({ classification, reason });
  expect(f.text).not.toHaveBeenCalled();
});

it.each([
  'event: text\ndata: {"text":"partial"}\n\n',
  'event: done\ndata: {"reason":"completed"}',
  'event: done\ndata: invalid\n\n',
  `event: text\ndata: ${'x'.repeat(2 * 1024 * 1024 + 1)}`,
])('rejects missing, truncated, malformed or oversized terminal framing', async wire => {
  const f = response([encode(wire)]);
  await expect(readMcpAgentTerminal(f.value, new AbortController().signal)).rejects.toBeInstanceOf(AgentStreamInterruptedError);
});

it('cancels a blocked read when its lifetime is aborted', async () => {
  const controller = new AbortController();
  const cancel = vi.fn();
  const value = new Response(new ReadableStream({ cancel }));
  const result = readMcpAgentTerminal(value, controller.signal);
  controller.abort(new Error('requested stop'));
  await expect(result).rejects.toThrow('requested stop');
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(['replacement', null])('rejects a cancellation terminal with mismatched or missing identity: %s', async busId => {
  const wire = (busId ? `event: bus_info\ndata: ${JSON.stringify({ bus_id: busId })}\n\n` : '')
    + 'event: done\ndata: {"reason":"aborted"}\n\n';
  await expect(readMcpAgentTerminal(new Response(wire), new AbortController().signal, { expected: 'original' }))
    .rejects.toBeInstanceOf(AgentStreamInterruptedError);
});

it('observes the original bus identity and accepts its matching terminal', async () => {
  const observed = vi.fn();
  const wire = 'event: bus_info\ndata: {"bus_id":"original"}\n\nevent: done\ndata: {"reason":"aborted"}\n\n';
  expect((await readMcpAgentTerminal(new Response(wire), new AbortController().signal, { expected: 'original', observed })).classification).toBe('cancelled');
  expect(observed).toHaveBeenCalledWith('original');
});
