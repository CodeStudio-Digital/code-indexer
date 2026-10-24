import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { setGlobalAgentLspBackend } from '../../../packages/code-agent/src/lsp/agent-lsp-backend.js';

const fixture = vi.hoisted(() => ({ workers: [] as any[], available: true }));
vi.mock('../workers/native-lsp-process.js', () => ({ NativeLspProcess: class extends EventEmitter {
  reaped = false; messages: any[] = []; release?: () => void; terminate = vi.fn(() => new Promise<number>(resolve => {
    this.release = () => { this.reaped = true; this.emit('exit', 0); resolve(0); };
  }));
  constructor() { super(); if (!fixture.available) throw new Error('rebuild required'); fixture.workers.push(this); }
  postMessage(message: unknown) { this.messages.push(message); }
} }));
import { NativeLspPort } from '../workers/native-lsp-port.js';
const options = { spawn: vi.fn(), deadline: Date.now() + 60000 };
const query = { op: 'references' as const, root: process.cwd(), projectName: 'fixture', file: 'sample.ts', line: 1, column: 1 };
afterEach(() => { fixture.workers.length = 0; fixture.available = true; setGlobalAgentLspBackend(null); });

it('reuses a warm owned worker and waits for physical termination on cancellation', async () => {
  const ctrl = new AbortController(), owner = vi.fn(), port = new NativeLspPort(ctrl.signal, owner, options);
  const first = port.query(query), worker = fixture.workers[0];
  worker.emit('message', { id: 1, encoded: JSON.stringify({ kind: 'locations', items: [], total: 0, offset: 0 }) });
  expect(await first).toMatchObject({ kind: 'locations', total: 0 });
  const abort = new AbortController(); const pending = port.query(query, abort.signal);
  let settled = false; const observed = pending.catch(error => { settled = true; return error; });
  expect(fixture.workers).toHaveLength(1); abort.abort(new Error('cancelled by caller'));
  await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  expect(settled).toBe(false); worker.release();
  expect((await observed).message).toContain('cancelled by caller');
  await port.close(); expect(() => port.query(query)).toThrow('closed');
});

it('revokes before dispatch and never falls back to synchronous TypeScript', async () => {
  const ctrl = new AbortController(), owner = vi.fn(), port = new NativeLspPort(ctrl.signal, owner, options);
  fixture.available = false; await expect(port.query(query)).rejects.toThrow('rebuild');
  expect(fixture.workers).toHaveLength(0);
  owner.mockImplementation(() => { throw new Error('revoked'); });
  expect(() => port.query(query)).toThrow('revoked'); await port.close();
});

it('does not overlap computations and replaces a failed worker only after termination', async () => {
  const port = new NativeLspPort(new AbortController().signal, () => {}, options);
  const first = port.query(query), rejected = expect(first).rejects.toThrow('heap exceeded'), worker = fixture.workers[0];
  expect(() => port.query(query)).toThrow('active computation');
  worker.emit('error', new Error('heap exceeded'));
  await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce()); worker.release(); await rejected;
  const next = port.query(query), replacement = fixture.workers[1];
  replacement.emit('message', { id: 2, encoded: JSON.stringify({ kind: 'hover', hover: null }) }); await next;
  const closed = port.close(); replacement.release(); await closed;
});

it('passes cancellation to other languages and preserves failure instead of returning empty results', async () => {
  const ctrl = new AbortController(), port = new NativeLspPort(ctrl.signal, () => {}, options);
  const references = vi.fn(async (_input, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  setGlobalAgentLspBackend({ references, definition: async () => null, hover: async () => null });
  const pending = port.query({ ...query, file: 'sample.py' }); const rejected = expect(pending).rejects.toThrow('owner closed');
  await port.close(); await rejected; expect(references.mock.calls[0][1].aborted).toBe(true);
  expect(fixture.workers).toHaveLength(0);
});

it('keeps a missing physical receipt as a permanent cleanup failure, including later close', async () => {
  const ctrl = new AbortController(), port = new NativeLspPort(ctrl.signal, () => {}, options);
  const first = port.query(query), worker = fixture.workers[0];
  worker.terminate.mockRejectedValue(new Error('missing physical receipt'));
  const rejected = expect(first).rejects.toThrow('missing physical receipt'); ctrl.abort(); await rejected;
  await expect(port.close()).rejects.toThrow('missing physical receipt');
  expect(() => port.query(query)).toThrow('missing physical receipt');
});
