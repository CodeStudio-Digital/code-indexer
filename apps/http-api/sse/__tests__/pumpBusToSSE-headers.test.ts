/**
 * Regression — the coder chat SSE routes were the only SSE routes without
 * `X-Accel-Buffering: no`, so buffering proxies (nginx / Cloudflare / dev
 * proxy) could hold frames and deliver tokens in bursts. The shared pump
 * now sets the header once for every consumer (attach + messages + company
 * + projects), matching the precedent in docs-agent/index.ts and
 * docs/index.ts (`markUnbuffered`).
 */
import { afterEach, describe, it, expect } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { createBus, markEnded, publish } from '../../coder-bus.js';
import { pumpBusToSSE } from '../pumpBusToSSE.js';

afterEach(() => {
  delete process.env.CODER_ATTACH_REPLAY_TRIM;
});

describe('pumpBusToSSE response headers', () => {
  it('sets X-Accel-Buffering: no on the SSE response', async () => {
    const app = new HttpRouter();
    const bus = createBus(new AbortController());
    app.get('/sse', (c) => pumpBusToSSE(c, bus, { heartbeat: false }));
    const res = await app.request('/sse');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    markEnded(bus, 'done', {});
    await res.body?.cancel().catch(() => {});
  });

  it('still emits the bus_info preamble with dropped_replay_events', async () => {
    const app = new HttpRouter();
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

  it('synthesizes one terminal frame when markEnded had no published terminal row', async () => {
    const app = new HttpRouter();
    const bus = createBus(new AbortController());
    publish(bus, 'text', { text: 'complete' });
    markEnded(bus, 'done', { reason: 'completed' });
    app.get('/sse', (c) => pumpBusToSSE(c, bus, { heartbeat: false }));

    const body = await (await app.request('/sse')).text();
    expect(body).toContain('event: text');
    expect(body).toContain('event: done');
    expect(body.match(/event: done/g)).toHaveLength(1);
  });

  it('does not duplicate a terminal row that was already published', async () => {
    const app = new HttpRouter();
    const bus = createBus(new AbortController());
    publish(bus, 'done', { reason: 'completed' });
    markEnded(bus, 'done', { reason: 'completed' });
    app.get('/sse', (c) => pumpBusToSSE(c, bus, { heartbeat: false }));

    const body = await (await app.request('/sse')).text();
    expect(body.match(/event: done/g)).toHaveLength(1);
  });

  it('applies a cursor only when it is paired with the current bus id', async () => {
    const app = new HttpRouter();
    const bus = createBus(new AbortController());
    publish(bus, 'text', { text: 'zero' });
    publish(bus, 'text', { text: 'one' });
    markEnded(bus, 'done', {});
    app.get('/sse', (c) => pumpBusToSSE(c, bus, { heartbeat: false }));

    const sameBus = await (await app.request('/sse', {
      headers: {
        'Last-Event-ID': '0',
        'X-MCP-Bus-ID': bus.busId,
      },
    })).text();
    expect(sameBus).not.toContain('id: 0');
    expect(sameBus).toContain('id: 1');

    const otherBus = await (await app.request('/sse', {
      headers: {
        'Last-Event-ID': '0',
        'X-MCP-Bus-ID': 'previous-run-bus',
      },
    })).text();
    expect(otherBus).toContain('id: 0');
    expect(otherBus).toContain('id: 1');
  });

  it('uses bounded semantic replay for a cursorless coder attach by default', async () => {
    const app = new HttpRouter();
    const bus = createBus(new AbortController());
    publish(bus, 'text', { text: 'persisted-old-delta' }); // seq 0, omitted
    publish(bus, 'message_complete', { usage: {} }); // seq 1, boundary
    publish(bus, 'text', { text: 'live-tail' }); // seq 2, retained
    markEnded(bus, 'done', {});
    app.get('/sse', (c) => pumpBusToSSE(c, bus, {
      heartbeat: false,
      trimReplay: true,
    }));

    const body = await (await app.request('/sse')).text();
    expect(body).not.toContain('id: 0');
    expect(body).toContain('id: 1');
    expect(body).toContain('id: 2');
    expect(body).toContain('live-tail');
  });

  it('keeps bounded replay when the retired compatibility opt-out is set', async () => {
    process.env.CODER_ATTACH_REPLAY_TRIM = '0';
    const app = new HttpRouter();
    const bus = createBus(new AbortController());
    publish(bus, 'text', { text: 'persisted-old-delta' }); // seq 0
    publish(bus, 'message_complete', { usage: {} }); // seq 1
    publish(bus, 'text', { text: 'live-tail' }); // seq 2
    markEnded(bus, 'done', {});
    app.get('/sse', (c) => pumpBusToSSE(c, bus, {
      heartbeat: false,
      trimReplay: true,
    }));

    const body = await (await app.request('/sse')).text();
    expect(body).not.toContain('id: 0');
    expect(body).not.toContain('persisted-old-delta');
    expect(body).toContain('live-tail');
  });
});
