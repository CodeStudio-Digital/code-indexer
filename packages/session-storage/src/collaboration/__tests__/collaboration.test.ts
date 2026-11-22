import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatCollaborationStore } from '../store.js';

describe('durable collaboration across independent workers', () => {
  let directory: string;
  let first: ChatCollaborationStore;
  let second: ChatCollaborationStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'chat-collaboration-'));
    first = new ChatCollaborationStore(directory); second = new ChatCollaborationStore(directory);
    await first.init();
    await first.registerRoot('a', 'Frontend'); await second.registerRoot('b', 'Backend');
    await first.linkSessions('a', 'b', true);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('reads one directory per snapshot and reflects link revocation on the next request', async () => {
    await first.registerRoot('c', 'Unrelated');
    await first.register({ id: 'child:a', sessionId: 'a', parentId: 'chat:a', label: 'Child', profile: 'review', state: 'idle' });
    await second.linkSessions('b', 'c', true);
    const list = vi.spyOn(first.files, 'list');
    const get = vi.spyOn(first.files, 'get');
    const snapshot = await first.directory('chat:a');
    expect(snapshot.peers.map(p => p.id)).toEqual(['chat:b', 'child:a']);
    expect(list.mock.calls.map(([kind]) => kind).sort()).toEqual(['links', 'participants']);
    expect(get).not.toHaveBeenCalled();
    await second.linkSessions('a', 'b', false);
    expect((await first.directory('chat:a')).peers.map(p => p.id)).toEqual(['child:a']);
    expect(await first.connected('a', 'b')).toBe(false);
  });

  it('delivers a correlated reply through filesystem events and retains it after reopening', async () => {
    const request = await first.send({ from: 'chat:a', to: 'chat:b', kind: 'question', body: 'What is the response type?', idempotencyKey: 'ask' });
    const waiting = first.wait('chat:a', request.id, 5000);
    const reply = await second.send({ from: 'chat:b', to: 'chat:a', kind: 'response', body: '{ userId: string }', replyTo: request.id, idempotencyKey: 'answer', references: ['src/contracts.ts'] });
    expect((await waiting).map(row => row.id)).toEqual([reply.id]);
    const reopened = new ChatCollaborationStore(directory);
    expect((await reopened.get(request.id)).status).toBe('answered');
    expect((await reopened.messages('chat:a'))[0].references).toEqual(['src/contracts.ts']);
  });
  it('deduplicates concurrent retries without partial JSON and refuses changed payloads', async () => {
    const input = { from: 'chat:a', to: 'chat:b', kind: 'task' as const, body: 'Implement contract', idempotencyKey: 'same-call' };
    const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).send(input)));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    expect(await first.messages('chat:b')).toHaveLength(1);
    await expect(second.send({ ...input, body: 'Different task' })).rejects.toThrow('Idempotency');
  });
  it('allows siblings and linked chats, while revoking disconnected access', async () => {
    await first.register({ id: 'child-a', sessionId: 'a', parentId: 'chat:a', label: 'Worker', profile: 'implement', state: 'running' });
    expect((await first.peers('child-a')).map(peer => peer.id)).toContain('chat:b');
    await first.linkSessions('a', 'b', false);
    await expect(first.send({ from: 'child-a', to: 'chat:b', kind: 'notify', body: 'hi', idempotencyKey: 'n' })).rejects.toThrow('not linked');
    expect((await first.peers('child-a')).map(peer => peer.id)).toEqual(['chat:a']);
  });
  it('does not let another recipient answer or acknowledge a request', async () => {
    const request = await first.send({ from: 'chat:a', to: 'chat:b', kind: 'question', body: 'Contract?', idempotencyKey: 'ask' });
    await expect(first.acknowledge('chat:a', request.id)).rejects.toThrow('recipient');
    await expect(first.send({ from: 'chat:a', to: 'chat:b', kind: 'response', body: 'forged', replyTo: request.id, idempotencyKey: 'fake' })).rejects.toThrow('does not match');
    await second.acknowledge('chat:b', request.id);
    expect((await first.get(request.id)).status).toBe('delivered');
  });
  it('cancels a pending wait and preserves cancellation after restart', async () => {
    const request = await first.send({ from: 'chat:a', to: 'chat:b', kind: 'task', body: 'Do work', idempotencyKey: 'work' });
    const waiting = first.wait('chat:a', request.id, 5000);
    await first.cancel('chat:a', request.id);
    expect(await waiting).toEqual([]);
    expect((await new ChatCollaborationStore(directory).get(request.id)).status).toBe('cancelled');
    await expect(second.send({ from: 'chat:b', to: 'chat:a', kind: 'response', body: 'late', replyTo: request.id, idempotencyKey: 'late' })).rejects.toThrow('no longer active');
  });
  it('refuses circular waits and releases the waiting edge after abort', async () => {
    const a = await first.send({ from: 'chat:a', to: 'chat:b', kind: 'question', body: 'A?', idempotencyKey: 'a' });
    const b = await second.send({ from: 'chat:b', to: 'chat:a', kind: 'question', body: 'B?', idempotencyKey: 'b' });
    const abort = new AbortController();
    const waiting = first.wait('chat:a', a.id, 5000, abort.signal).catch(error => error);
    const other = second.wait('chat:b', b.id, 5000, abort.signal).catch(error => error);
    const rejected = await Promise.race([waiting, other]);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected.message).toContain('Circular wait');
    abort.abort(); await Promise.all([waiting, other]);
    expect(await first.files.list('waits')).toEqual([]);
  });
});
