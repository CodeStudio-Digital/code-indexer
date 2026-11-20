/**
 * The worker-to-app transport of child chats: the worker's client and the
 * app's handlers over an in-memory bridge that clones payloads like the real
 * one. Calls reach the port as the worker's own session with the wait's long
 * deadline or a short one; a call made as another session is refused; a
 * cancelled wait aborts the app-side wait; no port fails the call; removing
 * the handlers ends pending waits.
 */
import { describe, expect, it, vi } from 'vitest';
import { createChildChatBridgeClient } from '@mcp/code-agent/ports/child-chat-bridge-client.js';
import type { ChildChatPort } from '@mcp/code-agent/ports/child-chat-port.js';
import { installChildChatBridge } from '../child-chat-bridge.js';

function bridgePair() {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const deadlines: Array<[string, number | undefined]> = [];
  const app = { handle: (type: string, handler: (payload: unknown) => unknown) => { handlers.set(type, handler); return () => handlers.delete(type); } };
  const worker = {
    async request<T>(type: string, payload: unknown, opts?: { timeoutMs?: number }): Promise<T> {
      deadlines.push([type, opts?.timeoutMs]);
      const handler = handlers.get(type);
      if (!handler) throw new Error(`no handler for ${type}`);
      return structuredClone(await handler(structuredClone(payload))) as T;
    },
  };
  return { app, worker, handlers, deadlines };
}

function fakePort(): ChildChatPort & { signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  return {
    signals,
    create: vi.fn(async (_caller, request) => ({ chatId: 'c1', title: request.title, profile: request.profile, readOnly: false, created: true })),
    stop: vi.fn(async () => ({ stopped: ['c1'] })),
    message: vi.fn(async () => ({ since: 'now' })),
    list: vi.fn(async () => []),
    wait: vi.fn((_caller, request, signal?: AbortSignal) => new Promise((resolve) => {
      signals.push(signal!);
      signal!.addEventListener('abort', () => resolve({ outcome: 'aborted', items: [] }), { once: true });
      if (request.timeoutMs === 0) resolve({ outcome: 'ready', items: [] });
    })),
  } as never;
}

describe('child-chat bridge', () => {
  it('serves the worker as its own session, with the long deadline only for waits', async () => {
    const pair = bridgePair();
    const port = fakePort();
    installChildChatBridge(pair.app, 'P1', () => port);
    const client = createChildChatBridgeClient(pair.worker);
    expect(await client.create('p1', { key: 'k', title: 't', profile: 'explore', task: 'do' })).toMatchObject({ chatId: 'c1' });
    expect(await client.wait('p1', { chatIds: ['c1'], timeoutMs: 0 })).toEqual({ outcome: 'ready', items: [] });
    await client.stop('p1', ['c1']);
    await client.message('p1', 'c1', { kind: 'task', message: 'm', key: 'k2', background: false });
    await client.list('p1');
    expect(port.create).toHaveBeenCalledWith('p1', expect.objectContaining({ key: 'k' }));
    expect(port.message).toHaveBeenCalledWith('p1', 'c1', expect.objectContaining({ key: 'k2' }));
    expect(pair.deadlines).toEqual([['childChat.create', 60_000], ['childChat.wait', 31 * 60_000], ['childChat.stop', 60_000],
      ['childChat.message', 60_000], ['childChat.list', 60_000]]);
  });

  it('refuses a call made as another session, and fails without a port', async () => {
    const pair = bridgePair();
    const port = fakePort();
    installChildChatBridge(pair.app, 'p1', () => port);
    const client = createChildChatBridgeClient(pair.worker);
    await expect(client.stop('p2', ['c1'])).rejects.toThrow('A worker can act only as its own session');
    expect(port.stop).not.toHaveBeenCalled();
    const empty = bridgePair();
    installChildChatBridge(empty.app, 'p1', () => null);
    await expect(createChildChatBridgeClient(empty.worker).list('p1')).rejects.toThrow(/unavailable/);
  });

  it('cancels the app-side wait when the waiting tool is aborted, and ends pending waits when removed', async () => {
    const pair = bridgePair();
    const port = fakePort();
    const remove = installChildChatBridge(pair.app, 'p1', () => port);
    const client = createChildChatBridgeClient(pair.worker);
    const tool = new AbortController();
    const waiting = client.wait('p1', { chatIds: ['c1'] }, tool.signal);
    await vi.waitFor(() => expect(port.signals).toHaveLength(1));
    tool.abort();
    expect(await waiting).toEqual({ outcome: 'aborted', items: [] });
    const pending = client.wait('p1', { chatIds: ['c1'] });
    await vi.waitFor(() => expect(port.signals).toHaveLength(2));
    remove();
    expect(await pending).toEqual({ outcome: 'aborted', items: [] });
    expect(pair.handlers.size).toBe(0);
  });
});
