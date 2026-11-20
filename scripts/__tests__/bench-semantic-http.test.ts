/**
 * The live bench's HTTP client to the app's semantic owner. These cases came
 * from the deleted loopback client tests (packages/indexer/src/agent-tools/
 * loopback/__tests__/semantic-search-client.test.ts and server-control.test.ts).
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBenchNamespaceWake, createBenchSemanticSearchClient, requestBenchServer } from '../bench-semantic-http.js';

const BASE = 'http://127.0.0.1:7333';
let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('bench semantic HTTP client', () => {
  it('delegates code and memory reads to the app endpoints', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url).includes('/agent-memory/search') ? json({ results: [] })
        : json({ results: [], diagnostics: { vectorAvailable: true, embeddingAvailable: true } }));
    const client = createBenchSemanticSearchClient(BASE, fetchImpl as typeof fetch);
    await expect(client.searchProject(7, 'related behavior', { mode: 'hybrid', type: 'symbols', limit: 9, consumer: 'agent', sessionId: 'session-7' }))
      .resolves.toMatchObject({ ok: true });
    await expect(client.searchProjectMemory(7, 'build recipe', 4)).resolves.toMatchObject({ ok: true });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${BASE}/api/projects/7/search?q=related+behavior&mode=hybrid&type=symbols&limit=9&consumer=agent`);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ headers: expect.objectContaining({ 'x-mcp-session-id': 'session-7' }) });
    expect(String(fetchImpl.mock.calls[1]![0])).toBe(`${BASE}/api/projects/7/agent-memory/search?q=build+recipe&limit=4&projection=ids`);
  });

  it('rejects malformed success payloads instead of hiding an ownership bug', async () => {
    const client = createBenchSemanticSearchClient(BASE, vi.fn(async () => json({})) as typeof fetch);
    await expect(client.searchProject(1, 'query')).resolves.toMatchObject({ ok: false, error: 'semantic server returned an invalid search payload' });
  });

  it.each([[null], [{ id: '4', score: 1 }], [{ id: -1, score: 1 }], [{ id: 4 }], Array.from({ length: 51 }, (_, i) => ({ id: i + 1, score: 1 }))].map(results => ({ results })))(
    'rejects invalid or oversized memory rank pages', async ({ results }) => {
      const client = createBenchSemanticSearchClient(BASE, vi.fn(async () => new Response(JSON.stringify({ results }), { status: 200 })) as typeof fetch);
      await expect(client.searchProjectMemory(1, 'query')).resolves.toMatchObject({ ok: false });
    },
  );

  it('wakes the targeted namespace with one POST', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ ok: true }));
    await createBenchNamespaceWake(BASE, fetchImpl as typeof fetch)('memory:project:p7');
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${BASE}/api/semantic/namespaces/reconcile`);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: JSON.stringify({ namespace: 'memory:project:p7' }) });
  });
});

describe('bench HTTP request contract', () => {
  it('rejects pre-cancelled requests without reaching the server', async () => {
    const fetchImpl = vi.fn();
    await expect(requestBenchServer(BASE, '/read', { signal: AbortSignal.abort(new Error('stopped')) }, { fetchImpl }))
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
    const result = createBenchSemanticSearchClient(`http://127.0.0.1:${port}`).searchProjectMemory(1, 'query', 5, ctrl.signal);
    const rejected = expect(result).rejects.toThrow('attempt stopped');
    await headers; ctrl.abort(new Error('attempt stopped')); await rejected; await socketClosed;
  });

  it('bounds a streamed body, awaits its cancellation and rejects malformed success JSON', async () => {
    const cancelled = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel: cancelled,
    })));
    await expect(requestBenchServer(BASE, '/read', {}, { fetchImpl, maxResponseBytes: 10 }))
      .resolves.toMatchObject({ ok: false, error: 'JSON response exceeds 10 bytes' });
    expect(cancelled).toHaveBeenCalledTimes(1);
    await expect(requestBenchServer(BASE, '/read', {}, { fetchImpl: async () => new Response('invalid') }))
      .resolves.toMatchObject({ ok: false });
  });

  it('keeps a deadline active after headers and distinguishes it from caller cancellation', async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }));
    const result = await requestBenchServer(BASE, '/read', {}, { fetchImpl: async () => response, timeoutMs: 15 });
    expect(result).toMatchObject({ ok: false, error: 'Local server request timed out' });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('forwards the same cancellation contract for project search', async () => {
    const ctrl = new AbortController();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      ctrl.abort(new Error('replaced')); expect(init!.signal!.aborted).toBe(true);
      return new Response(JSON.stringify({ results: [], diagnostics: {} }));
    });
    await expect(createBenchSemanticSearchClient(BASE, fetchImpl as typeof fetch).searchProject(1, 'query', { signal: ctrl.signal }))
      .rejects.toThrow('replaced');
  });
});
