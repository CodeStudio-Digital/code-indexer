import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { listenHttp } from '../node-server.js';
import { HttpRouter } from '../router.js';
import { streamSSE } from '../sse.js';

describe('Node HTTP transport', () => {
  it('passes the peer, repeated cookies and stream cancellation between Node and Fetch', async () => {
    const app = new HttpRouter();
    let onDisconnect!: () => void;
    const disconnected = new Promise<void>(resolve => { onDisconnect = resolve; });
    app.post('/form', async c => {
      c.header('Set-Cookie', 'a=1', { append: true });
      c.header('Set-Cookie', 'b=2', { append: true });
      return c.json({ peer: c.env?.incoming?.socket.remoteAddress, form: await c.req.parseBody() });
    });
    app.get('/events', c => streamSSE(c, async stream => {
      stream.onAbort(onDisconnect);
      await stream.writeSSE({ event: 'ready', id: '1', data: 'line 1\nline 2' });
      await disconnected;
    }));

    const server = listenHttp({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP address');
      const base = `http://127.0.0.1:${address.port}`;
      const form = await fetch(`${base}/form`, { method: 'POST', body: new URLSearchParams({ test: 'a b' }) });
      expect(form.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
      expect(await form.json()).toEqual({ peer: '127.0.0.1', form: { test: 'a b' } });

      const controller = new AbortController();
      const response = await fetch(`${base}/events`, { signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let wire = '';
      while (!wire.endsWith('\n\n')) {
        const { done, value } = await reader.read();
        if (done) throw new Error('SSE ended before delivering the event');
        wire += decoder.decode(value, { stream: true });
      }
      expect(wire).toBe('event: ready\ndata: line 1\ndata: line 2\nid: 1\n\n');
      controller.abort();
      await disconnected;
    } finally {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }, 5000);
});
