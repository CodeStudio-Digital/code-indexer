import { createServer, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import { requestMcpLocalServer } from '../server-control.js';
import { createMcpSemanticSearchClient } from '../semantic-search-client.js';

const config = { dashboard: { host: '127.0.0.1', port: 7333 } } as IndexerConfig;
let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });

it('rejects pre-cancelled requests without reaching the server', async () => {
  const fetchImpl = vi.fn();
  await expect(requestMcpLocalServer('/read', { signal: AbortSignal.abort(new Error('stopped')) }, { config, fetchImpl }))
    .rejects.toThrow('stopped');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('cancels a real socket during body streaming and preserves the caller cancellation', async () => {
  let started!: () => void, closed!: () => void;
  const headers = new Promise<void>(resolve => { started = resolve; });
  const socketClosed = new Promise<void>(resolve => { closed = resolve; });
  server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"results":'); res.once('close', closed); started(); });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const ctrl = new AbortController();
  const client = createMcpSemanticSearchClient({ dashboard: { host: '127.0.0.1', port } } as IndexerConfig);
  const result = client.searchProjectMemory(1, 'query', 5, ctrl.signal);
  const rejected = expect(result).rejects.toThrow('attempt stopped');
  await headers; ctrl.abort(new Error('attempt stopped')); await rejected; await socketClosed;
});

it('bounds a streamed body, awaits its cancellation and rejects malformed success JSON', async () => {
  const cancelled = vi.fn();
  const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel: cancelled,
  })));
  await expect(requestMcpLocalServer('/read', {}, { config, fetchImpl, maxResponseBytes: 10 }))
    .resolves.toMatchObject({ ok: false, error: 'JSON response exceeds 10 bytes' });
  expect(cancelled).toHaveBeenCalledTimes(1);
  await expect(requestMcpLocalServer('/read', {}, { config, fetchImpl: async () => new Response('invalid') }))
    .resolves.toMatchObject({ ok: false });
});

it('keeps a deadline active after headers and distinguishes it from caller cancellation', async () => {
  const cancelled = vi.fn();
  const response = new Response(new ReadableStream({ cancel: cancelled }));
  const result = await requestMcpLocalServer('/read', {}, { config, fetchImpl: async () => response, timeoutMs: 15 });
  expect(result).toMatchObject({ ok: false, error: 'Local server request timed out' });
  expect(cancelled).toHaveBeenCalledTimes(1);
});

it('forwards the same cancellation contract for project search', async () => {
  const ctrl = new AbortController();
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    ctrl.abort(new Error('replaced')); expect(init!.signal!.aborted).toBe(true);
    return new Response(JSON.stringify({ results: [], diagnostics: {} }));
  });
  const client = createMcpSemanticSearchClient(config, fetchImpl as typeof fetch);
  await expect(client.searchProject(1, 'query', { signal: ctrl.signal })).rejects.toThrow('replaced');
});
