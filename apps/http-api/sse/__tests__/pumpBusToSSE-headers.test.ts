/**
 * Regression — the coder chat SSE routes were the only SSE routes without
 * `X-Accel-Buffering: no`, so buffering proxies (nginx / Cloudflare / dev
 * proxy) could hold frames and deliver tokens in bursts. The shared pump
 * now sets the header once for every consumer (attach + messages + company
 * + projects), matching the precedent in docs-agent/index.ts and
 * docs/index.ts (`markUnbuffered`).
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createBus, markEnded, publish } from '../../coder-bus.js';
import { pumpBusToSSE } from '../pumpBusToSSE.js';

describe('pumpBusToSSE response headers', () => {
  it('sets X-Accel-Buffering: no on the SSE response', async () => {
    const app = new Hono();
    const bus = createBus(new AbortController());
    app.get('/sse', (c) => pumpBusToSSE(c, bus, { heartbeat: false }));
    const res = await app.request('/sse');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    markEnded(bus, 'done', {});
    await res.body?.cancel().catch(() => {});
  });

  it('still emits the bus_info preamble with dropped_replay_events', async () => {
    const app = new Hono();
    const bus = createBus(new AbortController());
    publish(bus, 'text', { delta: 'hi' });
    app.get('/sse', (c) => pumpBusToSSE(c, bus, { heartbeat: false }));
    const res = await app.request('/sse');
    const reader = res.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain('event: bus_info');
    expect(text).toContain('dropped_replay_events');
    markEnded(bus, 'done', {});
    await reader.cancel().catch(() => {});
  });
});
