/**
 * Unit test for the shared http-engine: doRequest transport, cookie-jar
 * helpers, and the jar-aware sendHttp (login flow + JSON body).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  createJar,
  cookieHeaderFor,
  storeSetCookies,
  isLoopbackHost,
  doRequest,
  sendHttp,
} from '../http-engine.js';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? '';
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === '/echo' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received: Buffer.concat(chunks).toString('utf8'), ct: req.headers['content-type'] }));
      });
    } else if (req.url === '/login' && req.method === 'POST') {
      res.writeHead(200, { 'set-cookie': 'sid=zzz; Path=/' });
      res.end('ok');
    } else if (req.url === '/me') {
      res.writeHead(cookie.includes('sid=zzz') ? 200 : 401);
      res.end(cookie.includes('sid=zzz') ? 'me' : 'no');
    } else if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '80000' });
      res.end('A'.repeat(80_000));
    } else if (req.url === '/chunked-large') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('B'.repeat(40_000));
      res.end('B'.repeat(40_000));
    } else if (req.url === '/unicode-cap') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(Buffer.from('é🙂UNREAD_TAIL', 'utf8'));
    } else {
      res.writeHead(404);
      res.end('nf');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('http-engine cookie jar', () => {
  it('stores and serializes cookies per host', () => {
    const jar = createJar();
    storeSetCookies(jar, 'example.com', 'a=1; Path=/');
    storeSetCookies(jar, 'example.com', ['b=2; HttpOnly', 'c=3']);
    expect(cookieHeaderFor(jar, 'example.com')).toBe('a=1; b=2; c=3');
    expect(cookieHeaderFor(jar, 'other.com')).toBe('');
  });

  it('classifies loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('http-engine transport', () => {
  it('doRequest GETs a local endpoint', async () => {
    const res = await doRequest({
      url: new URL(`${base}/health`),
      method: 'GET',
      headers: {},
      insecure: true,
      timeoutMs: 5000,
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"ok":true');
    expect(res.sizeExact).toBe(true);
  });

  it('sendHttp serializes a JSON body with content-type', async () => {
    const res = await sendHttp({ url: new URL(`${base}/echo`), method: 'POST', json: { x: 1 } });
    expect(res.status).toBe(200);
    expect(res.body).toContain('"received":"{\\"x\\":1}"');
    expect(res.body).toContain('application/json');
  });

  it('keeps the exact prefix at the network read boundary and marks truncation', async () => {
    const res = await doRequest({
      url: new URL(`${base}/large`),
      method: 'GET',
      headers: {},
      insecure: true,
      timeoutMs: 5000,
      maxBytes: 32_000,
    });
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.body, 'utf8')).toBe(32_000);
    expect(res.body).toBe('A'.repeat(32_000));
    expect(res.size).toBeGreaterThan(32_000);
    expect(res.size).toBe(80_000);
    expect(res.sizeExact).toBe(true);
  });

  it('drops a partial trailing UTF-8 sequence instead of emitting U+FFFD past the byte cap', async () => {
    const maxBytes = 4; // complete "é" (2 bytes) + half of the 4-byte emoji
    const res = await doRequest({
      url: new URL(`${base}/unicode-cap`),
      method: 'GET',
      headers: {},
      insecure: true,
      timeoutMs: 5000,
      maxBytes,
    });

    expect(res.truncated).toBe(true);
    expect(res.body).toBe('é');
    expect(res.body).not.toContain('\uFFFD');
    expect(Buffer.byteLength(res.body, 'utf8')).toBeLessThanOrEqual(maxBytes);
  });

  it('labels an interrupted chunked response size as a lower bound', async () => {
    const res = await doRequest({
      url: new URL(`${base}/chunked-large`),
      method: 'GET',
      headers: {},
      insecure: true,
      timeoutMs: 5000,
      maxBytes: 32_000,
    });
    expect(res.truncated).toBe(true);
    expect(res.size).toBeGreaterThan(32_000);
    expect(res.size).toBeLessThanOrEqual(80_000);
    expect(res.sizeExact).toBe(false);
  });

  it('sendHttp carries the jar across a login flow', async () => {
    const jar = createJar();
    const login = await sendHttp({ url: new URL(`${base}/login`), method: 'POST', jar });
    expect(login.status).toBe(200);
    const me = await sendHttp({ url: new URL(`${base}/me`), jar });
    expect(me.status).toBe(200);
    expect(me.body).toBe('me');
    // a jar-less call is unauthenticated
    const anon = await sendHttp({ url: new URL(`${base}/me`) });
    expect(anon.status).toBe(401);
  });
});
