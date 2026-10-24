import { create } from '@bufbuild/protobuf';
import { agentV1Runtime as wire } from '@mcp/agent-runtime-contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeBoundaryContextPreparation } from '../native-boundary-context.js';
import { encodeProviderFrontier, decodeProviderFrontier } from '../../../../agent-runtime-host/src/native/ProviderFrontierCodec.js';
import { adaptProviderRequest, DEFAULT_PROVIDER_GATEWAY_LIMITS } from '@mcp/agent-runtime-host';

afterEach(() => vi.useRealTimers());
const message = (value: string) => create(wire.ProviderMessageSchema, { role: wire.ProviderMessageRole.USER,
  content: [{ body: { case: 'text', value: { body: { case: 'inlineUtf8', value } } } }] });
const start = (text = 'Fix the parser') => create(wire.ProviderStartSchema, {
  identity: { sessionId: 'session', agentRunId: 'run', attemptId: 'attempt' }, operationId: 'provider/1',
  binding: { effectiveProvider: 'fixture', effectiveModel: 'fixture' }, messages: [message(text)],
  previousResponseId: 'prior-response', previousResponseMessageCount: 1n,
});
const row = { id: 'memory', title: 'Parser convention', content: 'Preserve token spans.' };

it('waits at most 300 ms once and applies a late lookup only at the next provider boundary', async () => {
  vi.useFakeTimers(); let resolve!: (rows: typeof row[]) => void;
  const memory = vi.fn(() => new Promise<typeof row[]>(done => { resolve = done; }));
  const signal = new AbortController().signal; const preparation = new NativeBoundaryContextPreparation({ memory }, signal);
  const request = start(); let returned = false;
  const first = preparation.prepare(request, signal, false).then(result => { returned = true; return result; });
  await vi.advanceTimersByTimeAsync(299); expect(returned).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect((await first).context).toBeUndefined();
  const next = await preparation.prepare(request, signal, false); expect(next.context).toBeUndefined();
  expect(memory).toHaveBeenCalledOnce();
  resolve([row]); await vi.advanceTimersByTimeAsync(0);
  await expect(first).resolves.toMatchObject({ context: undefined });
  expect((await preparation.prepare(request, signal, true)).context).toBeUndefined();
  const applied = await preparation.prepare(request, signal, false);
  expect(applied.context?.contentUtf8).toContain(row.content); expect(applied.resetContinuation).toBe(true);
  expect(request.preparedBoundaryContext).toBeUndefined();
  expect((await preparation.prepare(request, signal, false)).resetContinuation).toBe(false);
  expect((await preparation.prepare(request, signal, true)).context).toEqual(applied.context);
});

it('preserves exact enrichment through the durable frontier and rejects rebinding it to different text', async () => {
  const signal = new AbortController().signal; const request = start();
  const preparation = new NativeBoundaryContextPreparation({ memory: async () => [row] }, signal);
  request.preparedBoundaryContext = (await preparation.prepare(request, signal, false)).context;
  const saved = encodeProviderFrontier(request); const restored = decodeProviderFrontier(saved.payload);
  expect(restored.value.context?.preparedBoundaryContext).toEqual(request.preparedBoundaryContext);
  const resumed = new NativeBoundaryContextPreparation({ memory: vi.fn(() => { throw new Error('must not refresh'); }) }, signal);
  expect(await resumed.prepare(request, signal, false)).toMatchObject({ context: request.preparedBoundaryContext, resetContinuation: false });
  const provider = await adaptProviderRequest(request, undefined, DEFAULT_PROVIDER_GATEWAY_LIMITS, signal);
  expect(JSON.stringify(provider.messages)).toContain(row.content);
  expect(JSON.stringify(request.messages)).not.toContain(row.content);
  request.messages[0] = message('Different request');
  expect(() => encodeProviderFrontier(request)).toThrow('different user message');
});

it('walks back continuation text, respects ignore-memory and bounds recalled bytes', async () => {
  const memory = vi.fn(async (_query: string) => [{ ...row, content: '界'.repeat(100_000) }]);
  const signal = new AbortController().signal; const preparation = new NativeBoundaryContextPreparation({ memory }, signal);
  const request = start(); request.messages.push(message('continue'));
  const result = await preparation.prepare(request, signal, false);
  expect(memory.mock.calls[0]?.[0]).toBe('Fix the parser');
  expect(Buffer.byteLength(result.context!.contentUtf8)).toBeLessThanOrEqual(32 * 1024);
  request.messages.push(message('Não use memória nesta tarefa'));
  const ignored = await preparation.prepare(request, signal, false);
  expect(ignored.context).toBeUndefined(); expect(ignored.resetContinuation).toBe(true);
  expect(memory).toHaveBeenCalledOnce();
});

it('does not apply a stale task result, overlap retrievals, or cross attempt ownership', async () => {
  vi.useFakeTimers(); let resolve!: (rows: typeof row[]) => void;
  const memory = vi.fn(() => new Promise<typeof row[]>(done => { resolve = done; }));
  const signal = new AbortController().signal; const preparation = new NativeBoundaryContextPreparation({ memory }, signal);
  const request = start(); const first = preparation.prepare(request, signal, false);
  await vi.advanceTimersByTimeAsync(300); await first;
  request.messages.push(message('Build the UI'));
  expect((await preparation.prepare(request, signal, false)).context).toBeUndefined();
  expect(memory).toHaveBeenCalledOnce();
  resolve([row]); await vi.advanceTimersByTimeAsync(0);
  memory.mockImplementation(async () => []);
  expect((await preparation.prepare(request, signal, false)).context).toBeUndefined();
  expect(memory).toHaveBeenCalledTimes(2);
  request.identity!.attemptId = 'different';
  await expect(preparation.prepare(request, signal, false)).rejects.toThrow('ownership');
});

it('settles cancellation promptly and ignores late completion after the attempt ends', async () => {
  const lifetime = new AbortController(); const stop = new AbortController();
  const memory = vi.fn(() => new Promise<typeof row[]>(() => {}));
  const preparation = new NativeBoundaryContextPreparation({ memory }, lifetime.signal);
  const pending = preparation.prepare(start(), stop.signal, false);
  stop.abort(new Error('cancelled')); await expect(pending).rejects.toThrow('cancelled');
  lifetime.abort(new Error('attempt closed'));
  await expect(preparation.prepare(start(), new AbortController().signal, false)).rejects.toThrow('attempt closed');
});
