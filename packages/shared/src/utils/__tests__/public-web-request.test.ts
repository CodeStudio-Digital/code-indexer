import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse, type RequestOptions } from 'node:http';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import type { Socket } from 'node:net';
const fixture = vi.hoisted(() => ({ pins: [] as string[] }));
vi.mock('../public-web-dns.js', () => ({ resolvePublicWebHost: vi.fn(async () => ({ address: '93.184.216.34', family: 4 })) }));
// Only this test redirects the actual socket to loopback. The production
// request still builds and proves its DNS pin before we substitute the route.
vi.mock('node:http', async original => {
  const http = await original<typeof import('node:http')>();
  return { ...http, request(url: URL, options: RequestOptions) {
    options.lookup!(url.hostname, { family: 4, all: false }, (_error, address) => fixture.pins.push(String(address)));
    return http.request(url, { ...options, lookup: (_host, _opts, cb) => cb(null, '127.0.0.1', 4) });
  } };
});
import { readPublicWeb } from '../public-web-request.js';
import { NativeWebPort } from '../../../../../apps/http-api/workers/native-web-port.js';
import { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';

let server: Server, base: string, sockets: Set<Socket>, requests: string[];
let respond: (req: IncomingMessage, res: ServerResponse) => void;
beforeEach(async () => {
  fixture.pins.length = 0; sockets = new Set(); requests = [];
  respond = (_req, res) => res.end('OK');
  server = createServer((req, res) => { requests.push(req.url ?? ''); respond(req, res); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://public.example:' + (server.address() as { port: number }).port;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
async function drained() {
  for (let n = 0; n < 50 && sockets.size; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(sockets.size).toBe(0);
}
const read = (path: string, maxBytes = 1024, signal?: AbortSignal) => readPublicWeb({ url: base + path, maxBytes, signal });

describe('owned public-page physical transfer', () => {
  it('pins a public address, follows validated redirects and reports the final URL', async () => {
    respond = (req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { location: '/page' }); res.end(); }
      else res.end('FINAL_PAGE');
    };
    const result = await read('/redirect'); expect(result.text).toBe('FINAL_PAGE'); expect(result.url).toBe(base + '/page');
    expect(fixture.pins).toEqual(['93.184.216.34', '93.184.216.34']); await drained();
  });
  it.each(['http://127.0.0.1/private', 'http://[::ffff:7f00:1]/private', 'file:///secret', 'http://u:p@example.com/'])('rejects redirect to %s before another physical request', async location => {
    respond = (_req, res) => { res.writeHead(302, { location }); res.flushHeaders(); };
    await expect(read('/redirect')).rejects.toThrow(); expect(requests).toEqual(['/redirect']); await drained();
  });
  it('strips caller credentials on cross-origin redirects', async () => {
    const seen: (string | undefined)[] = [];
    respond = (req, res) => {
      seen.push(req.headers['x-subscription-token'] as string | undefined);
      if (req.url === '/redirect') { res.writeHead(302, { location: base.replace('public.example', 'other.example') + '/page' }); res.end(); }
      else res.end('OK');
    };
    await readPublicWeb({ url: base + '/redirect', maxBytes: 1024, headers: { 'X-Subscription-Token': 'fixture' } });
    expect(seen).toEqual(['fixture', undefined]); await drained();
  });
  it.each(['gzip', 'br', 'deflate'])('caps decoded %s bodies and does not confuse compressed length with source size', async encoding => {
    const text = 'a'.repeat(1022) + '🙂' + 'z'.repeat(80000);
    const bytes = encoding === 'gzip' ? gzipSync(text) : encoding === 'br' ? brotliCompressSync(text) : deflateSync(text);
    respond = (_req, res) => { res.writeHead(200, { 'content-encoding': encoding, 'content-length': bytes.length }); res.end(bytes); };
    const result = await read('/compressed'); expect(result.text).toBe('a'.repeat(1022)); expect(result.truncated).toBe(true);
    expect(result.inputSizeExact).toBe(false); expect(result.inputBytes).toBeGreaterThan(1024); await drained();
  });
  it('keeps truthful declared length for an identity response', async () => {
    respond = (_req, res) => res.end('a'.repeat(80000));
    const result = await read('/cap'); expect(result.text.length).toBe(1024); expect(result.inputBytes).toBe(80000);
    expect(result.inputSizeExact).toBe(true); await drained();
  });
  it('closes an error response without waiting for a stalled body', async () => {
    respond = (_req, res) => { res.writeHead(503); res.flushHeaders(); };
    expect((await read('/failure')).status).toBe(503); await drained();
  });
  it('cancels a stalled decoded body and drains the socket', async () => {
    const controller = new AbortController(); let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    respond = (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.flushHeaders(); started(); };
    const pending = read('/stall', 1024, controller.signal); await ready; controller.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow(); await drained();
  });
  it('pre-dispatch authority loss prevents the physical request', async () => {
    let checks = 0;
    await expect(readPublicWeb({ url: base + '/no-dispatch', maxBytes: 1024,
      assertCurrent: () => { if (++checks >= 3) throw new Error('lease revoked'); } })).rejects.toThrow('lease revoked');
    expect(requests).toEqual([]); await drained();
  });
  it('overlaps independent reads, publishes the fast result first and closes an attempt with a pending read', async () => {
    const effects = new HostEffectScope(), ctrl = new AbortController();
    const port = new NativeWebPort({ effects, signal: ctrl.signal, assertOwner() {} });
    let release!: () => void, slowStarted!: () => void;
    const started = new Promise<void>(resolve => { slowStarted = resolve; });
    respond = (req, res) => { if (req.url === '/slow') { release = () => res.end('SLOW'); slowStarted(); } else res.end('FAST'); };
    let finishedSlow = false;
    const slow = port.read({ url: base + '/slow', maxBytes: 1024 }).then(result => { finishedSlow = true; return result; });
    await started;
    expect((await port.read({ url: base + '/fast', maxBytes: 1024 })).text).toBe('FAST'); expect(finishedSlow).toBe(false);
    release(); await slow;
    respond = (_req, res) => { res.writeHead(200); res.flushHeaders(); };
    const pending = port.read({ url: base + '/pending', maxBytes: 1024 });
    const rejected = expect(pending).rejects.toThrow();
    await port.close(); await rejected; expect(effects.activeCount).toBe(0); await drained();
    await expect(port.read({ url: base, maxBytes: 1024 })).rejects.toThrow('closed');
  });
});
