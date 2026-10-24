import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runAgentSession, type AgentCliOptions } from '../commands/agent-session-client.js';

const id = randomUUID();
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function fixture(events = frame('done', { reason: 'completed' }), options: Partial<AgentCliOptions> = {}) {
  const controller = new AbortController();
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const writes: string[] = [];
  let held: ReadableStreamDefaultController<Uint8Array> | undefined;
  const prompt = vi.fn(async () => 'y');
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith('/abort')) return Response.json({ ok: true });
    if (path.endsWith('/attach')) return new Response(frame('bus_info', { bus_id: 'original' }) + frame('done', { reason: 'aborted' }));
    if (path.endsWith('/messages')) return events === 'hold' ? new Response(new ReadableStream({ start(c) { held = c; } })) : new Response(events);
    if (path.endsWith('/tool-approval')) {
      held?.enqueue(new TextEncoder().encode(frame('tool_call_result', { id: 'write-1', name: 'write_file', result: { content: 'saved' }, duration_ms: 2 })
        + frame('done', { reason: 'completed' })));
      return Response.json({ ok: true });
    }
    if (path.endsWith('/answer')) return Response.json({ ok: true });
    const session = { id, provider: 'fixture', model: 'chosen-model' };
    return Response.json(path.includes('?') ? { session } : session);
  });
  const run = () => runAgentSession({ task: 'Read fixture', options: { provider: 'fixture', model: 'chosen-model', ...options },
    projectId: 1, projectName: 'fixture', request, io: { write: text => writes.push(text), prompt }, signal: controller.signal });
  return { calls, writes, request, controller, prompt, run,
    emit: (event: string, data: unknown) => held!.enqueue(new TextEncoder().encode(frame(event, data))) };
}

it('submits once through the neutral product endpoint and preserves the explicit runtime options', async () => {
  const f = fixture(frame('text', { text: 'answer' }) + frame('done', { reason: 'completed', usage: { input_tokens: 7, output_tokens: 3 } }),
    { agent: 'explore', profile: 'navigate', plan: true, maxTurns: 8, worktree: 'branch-dir', worktreeBranch: 'chosen-branch' });
  expect((await f.run()).classification).toBe('completed');
  expect(f.calls[0]!.body).toMatchObject({ provider: 'fixture', model: 'chosen-model', max_turns: 8, max_auto_continues: 0 });
  expect(f.calls[1]!.body).toMatchObject({ content: 'Read fixture', plan_mode: true, agent: 'explore', profile: 'navigate',
    worktree: { name: 'branch-dir', branch: 'chosen-branch' } });
  expect(f.calls[1]!.body!.client_msg_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.writes.join('')).toContain('tokens: 7 in / 3 out');
  expect(f.calls).toHaveLength(2);
});

it('continues the stored session without creating a new session or worktree', async () => {
  const f = fixture(undefined, { session: id, worktree: true, provider: 'ignored-for-existing' });
  await f.run();
  expect(f.calls[0]!.path).toBe(`/api/coder/sessions/${id}?tail=1`);
  expect(f.calls[1]!.body).not.toHaveProperty('worktree');
  expect(f.writes.join('')).toContain('(fixture/chosen-model)');
});

it('renders progress immediately and releases a mutating tool only through the keyed approval endpoint', async () => {
  const f = fixture('hold'); const result = f.run();
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  f.emit('text', { text: 'before approval' });
  await vi.waitFor(() => expect(f.writes.join('')).toContain('before approval'));
  f.emit('tool_approval_request', { toolUseId: 'write-1', toolName: 'write_file', riskClass: 'write', argsSummary: 'fixture.txt' });
  expect((await result).classification).toBe('completed');
  expect(f.calls[2]).toEqual({ path: `/api/coder/sessions/${id}/tool-approval`, body: { tool_use_id: 'write-1', approved: true } });
  expect(f.writes.join('')).toContain('saved');
});

it('cancels a blocked read, awaits a terminal after acknowledgement and never resubmits the task', async () => {
  const f = fixture('hold'); const result = f.run();
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  f.controller.abort();
  expect((await result).classification).toBe('cancelled');
  expect(f.calls.filter(call => call.path.endsWith('/abort'))).toHaveLength(1);
  expect(f.calls.filter(call => call.path.endsWith('/messages'))).toHaveLength(1);
  expect(f.calls.filter(call => call.path.endsWith('/attach'))).toHaveLength(1);
});

it('does not mistake an ACK for completion while cancellation is still draining', async () => {
  const f = fixture('hold'); let completed = false;
  const result = f.run().then(value => { completed = true; return value; });
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  let terminal!: ReadableStreamDefaultController<Uint8Array>;
  f.request.mockImplementationOnce(async () => Response.json({ ok: true }));
  f.request.mockImplementationOnce(async () => new Response(new ReadableStream({ start(c) { terminal = c; } })));
  f.controller.abort();
  await vi.waitFor(() => expect(terminal).toBeDefined());
  expect(completed).toBe(false); expect(f.writes.join('')).not.toContain('[done:');
  terminal.enqueue(new TextEncoder().encode(frame('done', { reason: 'completed' })));
  expect((await result).classification).toBe('completed');
});

it('rejects a reattached terminal from another run', async () => {
  const f = fixture('hold'); const result = f.run();
  const rejected = expect(result).rejects.toThrow('different run');
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  f.emit('bus_info', { bus_id: 'original' }); f.emit('text', { text: 'identity observed' });
  await vi.waitFor(() => expect(f.writes.join('')).toContain('identity observed'));
  f.request.mockImplementationOnce(async () => Response.json({ ok: true }));
  f.request.mockImplementationOnce(async () => new Response(frame('bus_info', { bus_id: 'replacement' }) + frame('done', { reason: 'aborted' })));
  f.controller.abort(); await rejected;
});

it('does not confirm cancellation when its terminal receipt is missing', async () => {
  const f = fixture('hold'); const result = f.run();
  const rejected = expect(result).rejects.toThrow('without a terminal receipt');
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  f.request.mockImplementationOnce(async () => Response.json({ ok: true }));
  f.request.mockImplementationOnce(async () => new Response(''));
  f.controller.abort(); await rejected;
  expect(f.writes.join('')).not.toContain('[done: cancelled]');
});

it('does not report cancellation as confirmed when its acknowledgement is lost', async () => {
  const f = fixture('hold'); const result = f.run();
  const rejected = expect(result).rejects.toThrow('could not be acknowledged');
  await vi.waitFor(() => expect(f.calls).toHaveLength(2));
  f.request.mockImplementationOnce(async () => { throw new Error('ACK lost'); });
  f.controller.abort(); await rejected;
  expect(f.writes.join('')).not.toContain('[done: cancelled]');
});

it('treats EOF without a terminal as uncertain and stops the accepted attempt without retry', async () => {
  const f = fixture(frame('text', { text: 'partial' }));
  await expect(f.run()).rejects.toThrow('without a terminal receipt');
  expect(f.calls.map(call => call.path.split('/').at(-1))).toEqual(['sessions', 'messages', 'abort']);
});

it.each([['error', 'provider_failed', 'failed'], ['done', 'max_turns', 'interrupted']])(
  'preserves %s/%s as %s', async (event, reason, classification) => {
    expect((await fixture(frame(event, { reason })).run()).classification).toBe(classification);
  });

it('does not cancel another active run when admission rejects the new command', async () => {
  const f = fixture();
  f.request.mockImplementationOnce(async () => Response.json({ id, provider: 'fixture', model: 'model' }));
  f.request.mockImplementationOnce(async () => Response.json({ error: 'already running' }, { status: 409 }));
  await expect(f.run()).rejects.toThrow('already running');
  expect(f.request).toHaveBeenCalledTimes(2);
});
