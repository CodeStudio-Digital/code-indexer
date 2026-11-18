import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { CodexResponsesWebSocket } from '../codex-websocket.js';

type Body = Record<string, unknown>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });
const output = [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }];
const request = (input: unknown[], extra: Body = {}) => ({ model: 'model', store: false,
  instructions: 'sys', stream: true, tools: [], input, ...extra });
function complete(ws: WebSocket, id: string, items: unknown[] = output) {
  ws.send(JSON.stringify({ type: 'response.completed', response: { id, output: items } }));
}
async function fixture(onRequest: (ws: WebSocket, body: Body, index: number) => void, idleMs = 120_000) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected pipe');
  const requests: Body[] = [];
  let connections = 0;
  server.on('connection', (ws) => {
    connections++;
    ws.on('message', (raw) => { const body = JSON.parse(raw.toString()) as Body; requests.push(body); onRequest(ws, body, requests.length); });
  });
  const client = new CodexResponsesWebSocket(`ws://127.0.0.1:${address.port}`, {}, idleMs);
  cleanups.push(async () => {
    client.close(); for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const turn = async (input: unknown[], key = 'session', extra: Body = {}) => {
    const response = await client.open(key, request(input, extra));
    expect(response).not.toBeNull();
    const events: Body[] = [];
    for await (const event of response!.stream) events.push(event);
    return { events, incremental: response!.incremental, inputItems: response!.inputItems,
      reason: response!.continuationReason, changedFields: response!.changedConfigFields };
  };
  return { client, server, requests, turn, get connections() { return connections; } };
}

it('reuses the connection and sends only a verified suffix, even with store:false', async () => {
  const f = await fixture((ws, _body, index) => complete(ws, `resp_${index}`));
  const firstInput = [user('inspect')];
  expect(await f.turn(firstInput, 'session', { optional: undefined })).toMatchObject({ reason: 'new_connection_or_no_response', changedFields: [] });
  const next = { type: 'function_call_output', call_id: 'call_1', output: 'contents' };
  expect(await f.turn([...firstInput, ...output, next])).toMatchObject({ incremental: true, inputItems: 1, reason: 'reused', changedFields: [] });
  expect(f.connections).toBe(1);
  expect(f.requests[1]).toMatchObject({ previous_response_id: 'resp_1', input: [next], store: false });
  expect(f.requests[1]).not.toHaveProperty('stream');
});

it('resets the prefix on compaction, changed instructions, another session and reconnect', async () => {
  const f = await fixture((ws, _body, index) => complete(ws, `resp_${index}`));
  await f.turn([user('old')]);
  const compacted = [user('summary')];
  expect((await f.turn(compacted)).incremental).toBe(false);
  const continuation = [...compacted, ...output, user('next')];
  expect(await f.turn(continuation, 'session', { instructions: 'changed' })).toMatchObject({ incremental: false,
    reason: 'configuration_changed', changedFields: ['instructions'] });
  expect((await f.turn(continuation, 'another')).incremental).toBe(false);
  f.client.close();
  expect((await f.turn(continuation)).incremental).toBe(false);
  expect(f.requests.every((r) => !r.previous_response_id)).toBe(true);
});

it('recovers an evicted response ID once using full input and does not repeat unrelated errors', async () => {
  const f = await fixture((ws, body, index) => {
    if (index === 2) ws.send(JSON.stringify({ type: 'error', error: { code: 'previous_response_not_found' } }));
    else if (index === 4) ws.send(JSON.stringify({ type: 'error', error: { code: 'invalid_function_parameters' } }));
    else complete(ws, `resp_${index}`);
  });
  const initial = [user('inspect')];
  await f.turn(initial);
  const next = [...initial, ...output, user('continue')];
  expect(await f.turn(next)).toMatchObject({ incremental: false, reason: 'server_reference_not_found' });
  expect(f.requests[2]).toMatchObject({ input: next });
  expect(f.requests[2]).not.toHaveProperty('previous_response_id');
  const failed = await f.turn([...next, ...output, user('last')]);
  expect(failed.events.at(-1)).toMatchObject({ type: 'error' });
  expect(f.requests).toHaveLength(4);
});

it('does not reuse a missing ID after output began, or hide a truncated connection', async () => {
  const f = await fixture((ws, _body, index) => {
    if (index === 1) complete(ws, 'resp_1');
    else if (index === 2) {
      ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }));
      ws.send(JSON.stringify({ type: 'error', error: { code: 'previous_response_not_found' } }));
    } else ws.close();
  });
  await f.turn([user('start')]);
  await f.turn([user('start'), ...output, user('next')]);
  expect(f.requests).toHaveLength(2);
  await expect(f.turn([user('retry')])).rejects.toThrow('before response.completed');
  expect(f.requests).toHaveLength(3);
});

it('bounds request queues when the consumer stops draining', async () => {
  const f = await fixture((ws) => {
    for (let i = 0; i < 4100; i++) ws.send(JSON.stringify({ type: 'response.created', sequence_number: i }));
  });
  const active = await f.client.open('slow', request([user('start')]));
  await vi.waitFor(() => expect(f.server.clients.size).toBe(0));
  await expect((async () => { for await (const _event of active!.stream) { /* drain */ } })()).rejects.toMatchObject({ code: 'provider_buffer_limit' });
});

it('cancels an active request without allowing another session to consume its events', async () => {
  const f = await fixture((ws, _body, index) => { if (index > 1) complete(ws, `resp_${index}`); });
  const abort = new AbortController();
  const active = await f.client.open('A', request([user('pending')]), abort.signal);
  const iterator = active!.stream[Symbol.asyncIterator]();
  const pending = iterator.next();
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect(await f.client.open('A', request([user('concurrent')]))).toBeNull();
  abort.abort(new Error('user stopped'));
  await expect(pending).rejects.toThrow();
  expect((await f.turn([user('B')], 'B')).events.at(-1)).toMatchObject({ type: 'response.completed' });
  expect(f.requests[1]).not.toHaveProperty('previous_response_id');
});

it('accepts a queued terminal before close and releases idle connections', async () => {
  const f = await fixture((ws) => { complete(ws, 'done'); ws.close(); }, 15);
  expect((await f.turn([user('finish')])).events.at(-1)).toMatchObject({ type: 'response.completed' });
  const idle = await fixture((ws) => complete(ws, 'idle'), 15);
  await idle.turn([user('finish')]);
  await vi.waitFor(() => expect(idle.server.clients.size).toBe(0), { timeout: 1000 });
});

it('falls back only before sending on an unsupported HTTP upgrade', async () => {
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const client = new CodexResponsesWebSocket(`ws://127.0.0.1:${address.port}`, {});
  cleanups.push(async () => { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  expect(await client.open('s', request([user('hello')]))).toBeNull();
  expect(await client.open('s', request([user('hello')]))).toBeNull();
});
