import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeHttpPort } from '../workers/native-http-port.js';
import { HostEffectScope } from '@mcp/code-agent/runtime/host-effect-scope.js';
import { createJar, doRequest } from '@mcp/shared/utils/http-engine.js';
import { httpRequestTool } from '@mcp/code-agent/tools/http.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler), sockets = new Set<import('node:net').Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { base: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`, sockets };
}
function port(jar = createJar()) {
  const controller = new AbortController(), effects = new HostEffectScope(), unknown = vi.fn(), owner = vi.fn();
  const value = new NativeHttpPort({ jar, signal: controller.signal, effects, assertOwner: owner, outcomeUnknown: unknown });
  cleanup.push(() => value.close()); return { value, controller, effects, unknown, owner };
}
it('physically closes a stalled connection before attempt drain completes', async () => {
  let started = false;
  const target = await server(() => { started = true; }), scope = port();
  const pending = scope.value.send({ url: new URL(target.base) });
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(started).toBe(true));
  expect(scope.effects.activeCount).toBe(1);
  await scope.value.close(); await rejected;
  expect(scope.effects.activeCount).toBe(0);
  await vi.waitFor(() => expect(target.sockets.size).toBe(0));
  await expect(scope.value.send({ url: new URL(target.base) })).rejects.toThrow('closed');
});
it('retains session login across attempts without sharing another session jar', async () => {
  const target = await server((req, res) => {
    if (req.url === '/login') res.setHeader('set-cookie', 'session=fixture; Path=/');
    res.end(req.headers.cookie ?? 'anonymous');
  });
  const jar = createJar(), first = port(jar);
  await first.value.send({ url: new URL(`${target.base}/login`), method: 'POST' }); await first.value.close();
  const next = port(jar), other = port();
  expect((await next.value.send({ url: new URL(target.base) })).body).toBe('session=fixture');
  expect((await other.value.send({ url: new URL(target.base) })).body).toBe('anonymous');
  expect((await next.value.send({ url: new URL(target.base), resetCookies: true })).body).toBe('anonymous');
});
it('marks a lost write response unknown and prevents dispatch after cancellation', async () => {
  let writes = 0;
  const target = await server((req, res) => { writes++; req.resume(); res.destroy(); });
  const scope = port();
  const context: ToolContext = { cwd: process.cwd(), projectName: 'http-fixture', ports: { http: scope.value }, signal: scope.controller.signal };
  const result = await httpRequestTool.handler({ url: target.base, method: 'POST', json: { fixture: true } },
    context);
  expect(result.effectOutcome).toBe('unknown'); expect(scope.unknown).toHaveBeenCalledOnce(); expect(writes).toBe(1);
  scope.controller.abort();
  const cancelled = await httpRequestTool.handler({ url: target.base, method: 'POST' },
    context);
  expect(cancelled.effectOutcome).not.toBe('unknown'); expect(writes).toBe(1);
});
it('uses an absolute deadline even while a server keeps trickling bytes', async () => {
  const target = await server((_req, res) => {
    res.write('start'); const interval = setInterval(() => res.write('.'), 10);
    res.once('close', () => clearInterval(interval));
  });
  const before = performance.now();
  await expect(doRequest({ url: new URL(target.base), method: 'GET', headers: {}, insecure: false,
    isolatedConnection: true, timeoutMs: 80 })).rejects.toThrow('timed out');
  expect(performance.now() - before).toBeLessThan(2000);
  await vi.waitFor(() => expect(target.sockets.size).toBe(0));
});
it('does not create a connection for a revoked owner', async () => {
  const target = await server((_req, res) => res.end('unexpected')), scope = port();
  scope.owner.mockImplementation(() => { throw new Error('revoked'); });
  await expect(scope.value.send({ url: new URL(target.base) })).rejects.toThrow('revoked');
  expect(target.sockets.size).toBe(0); expect(scope.unknown).not.toHaveBeenCalled();
});
