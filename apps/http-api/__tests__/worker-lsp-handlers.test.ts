import { afterEach, expect, it, vi } from 'vitest';
import type { ApiContext } from '@mcp/api-bus';
import { registerWorkerLspHandlers, setWorkerLspDeps } from '../sse/worker-lsp-handlers.js';
import { installWorkerLspShim } from '../workers/lsp-shim.js';
import { getGlobalAgentLspBackend, setGlobalAgentLspBackend } from '@mcp/code-agent/lsp/agent-lsp-backend.js';

function bridge() {
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
  return { handle(name: string, fn: (payload: unknown) => Promise<unknown>) { handlers.set(name, fn); return () => { handlers.delete(name); }; },
    request: vi.fn(async (name: string, payload: unknown) => { const handler = handlers.get(name); if (!handler) throw new Error('No bridge handler'); return handler(payload); }) };
}
const input = { root: 'fixture-root', projectName: 'untrusted-name', file: 'a.py', position: { line: 1, column: 1 } };
afterEach(() => { setWorkerLspDeps(null); setGlobalAgentLspBackend(null); });

it('propagates a shim abort to its active read and awaits backend settlement', async () => {
  let received: AbortSignal | undefined, release: (() => void) | undefined;
  setWorkerLspDeps({ db: { getProjectByPath: () => ({ id: 7 }) }, handlers: {
    references: vi.fn(async (_args: unknown, ctx: ApiContext) => { received = ctx.signal; await new Promise<void>(resolve => { release = resolve; }); return []; }),
  } } as any);
  const channel = bridge(), close = registerWorkerLspHandlers(channel); installWorkerLspShim(channel);
  const ctrl = new AbortController(), pending = getGlobalAgentLspBackend()!.references(input, ctrl.signal);
  let settled = false; const observed = pending.catch(error => { settled = true; return error; });
  ctrl.abort(); await vi.waitFor(() => expect(received?.aborted).toBe(true)); expect(settled).toBe(false);
  release!(); expect(await observed).toBeInstanceOf(Error);
  expect(channel.request.mock.calls.map(call => call[0])).toEqual(['lspRequest', 'lspReadCancel']); close();
});

it('scopes ids to one caller and cancels all its reads on bridge disposal', async () => {
  const signals: AbortSignal[] = [], releases: Array<() => void> = [];
  setWorkerLspDeps({ db: { getProjectByPath: () => ({ id: 1 }) }, handlers: {
    hover: async (_args: unknown, ctx: ApiContext) => { signals.push(ctx.signal); await new Promise<void>(resolve => releases.push(resolve)); return null; },
  } } as any);
  const a = bridge(), b = bridge(), offA = registerWorkerLspHandlers(a), offB = registerWorkerLspHandlers(b);
  const payload = { ...input, op: 'hover', readId: 'shared-id-123' };
  const pa = a.request('lspRequest', payload), pb = b.request('lspRequest', payload);
  const ra = expect(pa).rejects.toThrow('cancelled'), rb = expect(pb).rejects.toThrow('closed');
  await a.request('lspReadCancel', { readId: payload.readId });
  expect(signals.map(signal => signal.aborted)).toEqual([true, false]); offB();
  expect(signals[1].aborted).toBe(true); releases.forEach(release => release()); await ra; await rb; offA();
});

it('does not substitute a project name or conceal unavailable backends as empty success', async () => {
  const byName = vi.fn(() => ({ id: 99 }));
  setWorkerLspDeps({ db: { getProjectByPath: () => null, getProjectByName: byName }, handlers: {} } as any);
  const channel = bridge(), close = registerWorkerLspHandlers(channel); installWorkerLspShim(channel);
  await expect(getGlobalAgentLspBackend()!.definition(input)).rejects.toThrow('root is not registered');
  expect(byName).not.toHaveBeenCalled();
  await expect(channel.request('lspRequest', { ...input, op: 'definition', position: { line: 0, column: 1 } })).rejects.toThrow('Invalid');
  close(); await expect(getGlobalAgentLspBackend()!.hover(input)).rejects.toThrow('No bridge handler');
});
