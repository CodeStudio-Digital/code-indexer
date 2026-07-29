/**
 * E2E test for the http_request tool against a REAL local node server —
 * covers GET, POST+json, the per-session cookie jar (login flow), session
 * isolation, and non-2xx handling (returns, never throws).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { httpRequestTool } from '../http.js';
import type { ToolContext, ToolResult } from '@mcp/code-agent/core/tool.js';

let server: Server;
let base = '';

const DEFAULT_SESSION_ID = '00000000-0000-4000-8000-000000000001';
const AUTHENTICATED_SESSION_ID = '00000000-0000-4000-8000-000000000042';
const ISOLATED_SESSION_ID = '00000000-0000-4000-8000-000000000099';

const ctx = (sessionId: string) => ({ sessionId }) as unknown as ToolContext;
const run = (args: Record<string, unknown>, sessionId = DEFAULT_SESSION_ID) =>
  httpRequestTool.handler(args, ctx(sessionId)) as Promise<ToolResult>;

beforeAll(async () => {
  server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? '';
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${'x'.repeat(20_000)}TAIL_SENTINEL`);
    } else if (req.url === '/huge') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${'h'.repeat(80_000)}UNREAD_TAIL`);
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

  it('returns a large body intact so the runner can spill it', async () => {
    const r = await run({ url: `${base}/large` });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('TAIL_SENTINEL');
    expect(r.content.length).toBeGreaterThan(20_000);
  });

  it('marks the intentional acquisition boundary instead of claiming a full result', async () => {
    const r = await run({ url: `${base}/huge`, maxBytes: 32_000 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('[source truncated: network read ceiling reached');
    expect(r.content).not.toContain('UNREAD_TAIL');
    expect(r.content.length).toBeLessThan(40_000);
    expect(r.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'network-acquisition-cap',
        unit: 'bytes',
        inputSizeExact: false,
        outputSize: 32_000,
        recoverable: false,
      }),
    ]);
    expect(r.sourceTruncations![0]!.inputSize).toBeGreaterThan(
      r.sourceTruncations![0]!.outputSize,
    );
  });

  it('rejects a non-http(s) url', async () => {
    const r = await run({ url: 'ftp://x/y' });
    expect(r.isError).toBe(true);
  });

  it('login flow: POST sets a cookie, then GET /me stays authenticated (cookie jar)', async () => {
    const login = await run(
      { method: 'POST', url: `${base}/login`, json: { email: 'a', senha: 'b' } },
      AUTHENTICATED_SESSION_ID,
    );
    expect(login.content).toContain('200');
    expect(login.content).toMatch(/set-cookie:\s*1 cookie/);
    const me = await run(
      { url: `${base}/me` },
      AUTHENTICATED_SESSION_ID,
    ); // same session → cookie carried
    expect(me.content).toContain('200');
    expect(me.content).toContain('maicon');
  });

  it('isolates the cookie jar per session', async () => {
    const me = await run(
      { url: `${base}/me` },
      ISOLATED_SESSION_ID,
    ); // different session → no cookie
    expect(me.content).toContain('401');
  });

  it('returns non-2xx as a normal result (no throw)', async () => {
    const r = await run({ url: `${base}/nope` });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('404');
  });
});
