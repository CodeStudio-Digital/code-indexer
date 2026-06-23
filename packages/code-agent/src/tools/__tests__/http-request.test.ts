/**
 * E2E test for the http_request tool against a REAL local node server —
 * covers GET, POST+json, the per-session cookie jar (login flow), session
 * isolation, and non-2xx handling (returns, never throws).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { httpRequestTool } from '../http.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

let server: Server;
let base = '';

const ctx = (sessionId: number) => ({ sessionId }) as unknown as ToolContext;
const run = (args: Record<string, unknown>, sessionId = 1) =>
  httpRequestTool.handler(args, ctx(sessionId)) as Promise<{ content: string; isError?: boolean }>;

beforeAll(async () => {
  server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? '';
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === '/login' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=abc123; Path=/; HttpOnly' });
      res.end(JSON.stringify({ token: 't' }));
    } else if (req.url === '/me') {
      if (cookie.includes('sid=abc123')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ user: 'maicon' }));
      } else {
        res.writeHead(401);
        res.end('unauthorized');
      }
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('http_request', () => {
  it('GETs a local endpoint (web_fetch would SSRF-block this)', async () => {
    const r = await run({ url: `${base}/health` });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('200');
    expect(r.content).toContain('"ok":true');
  });

  it('rejects a non-http(s) url', async () => {
    const r = await run({ url: 'ftp://x/y' });
    expect(r.isError).toBe(true);
  });

  it('login flow: POST sets a cookie, then GET /me stays authenticated (cookie jar)', async () => {
    const login = await run({ method: 'POST', url: `${base}/login`, json: { email: 'a', senha: 'b' } }, 42);
    expect(login.content).toContain('200');
    expect(login.content).toMatch(/set-cookie:\s*1 cookie/);
    const me = await run({ url: `${base}/me` }, 42); // same session → cookie carried
    expect(me.content).toContain('200');
    expect(me.content).toContain('maicon');
  });

  it('isolates the cookie jar per session', async () => {
    const me = await run({ url: `${base}/me` }, 99); // different session → no cookie
    expect(me.content).toContain('401');
  });

  it('returns non-2xx as a normal result (no throw)', async () => {
    const r = await run({ url: `${base}/nope` });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('404');
  });
});
