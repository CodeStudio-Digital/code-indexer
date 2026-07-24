/**
 * Unit tests for ReconnectingSSEClient.
 *
 * Focus: the reconnect contract that the server-side idempotency fix relies on
 * — on a mid-stream drop the client re-sends the FULL POST body (byte-identical)
 * plus a `Last-Event-ID` header. That re-POST is what the server dedupes via
 * `client_msg_id`, so this documents the behaviour the fix depends on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReconnectingSSEClient } from '../ReconnectingSSEClient.js';
import type { SSEEvent } from '../SSEFramer.js';

const enc = new TextEncoder();
const NO_BACKOFF = { nextDelay: () => 0 };

/** A Response whose body streams the given SSE frames then closes gracefully. */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * A Response whose body emits the frames one-per-pull, then errors on the next
 * pull (simulates a dropped socket). Pull-based (not enqueue-then-error) so the
 * consumer actually reads the frames before the error surfaces — `error()`
 * discards any still-queued chunks.
 */
function droppingResponse(frames: string[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]));
      else controller.error(new Error('network dropped'));
    },
  });
  return new Response(stream, { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe('ReconnectingSSEClient', () => {
  it('resolves on a terminal `done` event with a single fetch', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return sseResponse(['event: text\ndata: {"t":"hi"}\n\n', 'event: done\ndata: {}\n\n']);
    }));
    const events: SSEEvent[] = [];
    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'POST',
      body: { content: 'hi' },
      signal: new AbortController().signal,
      onEvent: (ev) => events.push(ev),
      backoff: NO_BACKOFF,
    }).run();

    expect(calls).toBe(1);
    expect(events.map((e) => e.event)).toEqual(['text', 'done']);
  });

  it('surfaces ping as liveness without mixing it into semantic events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'event: ping\ndata: 123\n\n',
      'event: done\ndata: {}\n\n',
    ])));
    const events: SSEEvent[] = [];
    const heartbeats: number[] = [];
    const phases: string[] = [];
    const before = Date.now();

    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'GET',
      signal: new AbortController().signal,
      onEvent: (ev) => events.push(ev),
      onHeartbeat: (receivedAt) => heartbeats.push(receivedAt),
      onPhase: (phase) => phases.push(phase),
      backoff: NO_BACKOFF,
    }).run();

    expect(events.map((event) => event.event)).toEqual(['done']);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toBeGreaterThanOrEqual(before);
    expect(heartbeats[0]).toBeLessThanOrEqual(Date.now());
    expect(phases).toEqual(['connecting', 'live']);
  });

  it('re-sends the identical body + a Last-Event-ID header on reconnect', async () => {
    const calls: Array<{ headers: Headers; body: unknown }> = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      n++;
      calls.push({ headers: new Headers(init.headers), body: init.body });
      return n === 1
        ? droppingResponse([
            'id: 0\nevent: text\ndata: {"a":1}\n\n',
            'id: 1\nevent: text\ndata: {"b":2}\n\n',
          ])
        : sseResponse(['id: 2\nevent: done\ndata: {}\n\n']);
    }));

    let lastSeen = -1;
    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'POST',
      body: { content: 'hi', client_msg_id: 'key-123' },
      signal: new AbortController().signal,
      onEvent: (ev) => { if (ev.id !== undefined) lastSeen = ev.id; },
      getLastEventId: () => lastSeen,
      getLastEventBusId: () => 'bus-1',
      backoff: NO_BACKOFF,
    }).run();

    expect(n).toBe(2);
    // Retry replays from the last id the client actually saw.
    expect(calls[0].headers.get('Last-Event-ID')).toBeNull();
    expect(calls[1].headers.get('Last-Event-ID')).toBe('1');
    expect(calls[0].headers.get('X-MCP-Bus-ID')).toBeNull();
    expect(calls[1].headers.get('X-MCP-Bus-ID')).toBe('bus-1');
    // The dedup contract: the body (with client_msg_id) is byte-identical on retry.
    expect(calls[1].body).toBe(calls[0].body);
    expect(JSON.parse(calls[0].body as string)).toEqual({ content: 'hi', client_msg_id: 'key-123' });
  });

  it('reconnects after a graceful EOF with no terminal event', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return n === 1
        ? sseResponse(['id: 0\nevent: text\ndata: {"t":1}\n\n'])
        : sseResponse(['id: 1\nevent: done\ndata: {}\n\n']);
    }));
    let lastSeen = -1;
    const reconnects: number[] = [];
    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'GET',
      signal: new AbortController().signal,
      onEvent: (ev) => { if (ev.id !== undefined) lastSeen = ev.id; },
      getLastEventId: () => lastSeen,
      onReconnect: (attempt) => { reconnects.push(attempt); },
      backoff: NO_BACKOFF,
    }).run();

    expect(n).toBe(2);
    expect(reconnects).toEqual([1]);
    const fetchMock = vi.mocked(fetch);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Last-Event-ID')).toBe('0');
  });

  it('rejects when repeated graceful EOFs exhaust the reconnect budget', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return sseResponse(['event: text\ndata: {"t":1}\n\n']);
    }));

    await expect(new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'GET',
      signal: new AbortController().signal,
      onEvent: () => {},
      backoff: { nextDelay: (attempt) => attempt === 0 ? 0 : null },
    }).run()).rejects.toMatchObject({
      name: 'SSEStreamEndedWithoutTerminalError',
      code: 'SSE_STREAM_ENDED_WITHOUT_TERMINAL',
    });
    expect(n).toBe(2);
  });

  it('resets the retry budget after a strictly newer event id', async () => {
    let n = 0;
    const attempts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      if (n <= 2) return droppingResponse([]);
      if (n === 3) return droppingResponse(['id: 0\nevent: text\ndata: {"t":1}\n\n']);
      return sseResponse(['id: 1\nevent: done\ndata: {}\n\n']);
    }));

    let lastSeen = -1;
    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'GET',
      signal: new AbortController().signal,
      onEvent: (ev) => { if (ev.id !== undefined) lastSeen = ev.id; },
      getLastEventId: () => lastSeen,
      backoff: {
        nextDelay: (attempt) => {
          attempts.push(attempt);
          return attempt < 3 ? 0 : null;
        },
      },
    }).run();

    expect(n).toBe(4);
    expect(attempts).toEqual([0, 1, 0]);
  });

  it('does not reset the retry budget for a duplicate replay id', async () => {
    let n = 0;
    const attempts: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return sseResponse(['id: 0\nevent: text\ndata: {"t":1}\n\n']);
    }));

    let lastSeen = -1;
    await expect(new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'GET',
      signal: new AbortController().signal,
      onEvent: (ev) => { if (ev.id !== undefined) lastSeen = ev.id; },
      getLastEventId: () => lastSeen,
      reconnectBudgetResetMs: Number.POSITIVE_INFINITY,
      backoff: {
        nextDelay: (attempt) => {
          attempts.push(attempt);
          return attempt < 2 ? 0 : null;
        },
      },
    }).run()).rejects.toMatchObject({
      code: 'SSE_STREAM_ENDED_WITHOUT_TERMINAL',
    });

    expect(n).toBe(3);
    expect(attempts).toEqual([0, 1, 2]);
  });

  it('throws a nonRetryable error on 4xx without retrying, surfacing status + body', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      return new Response(JSON.stringify({ code: 'INTERACTION_PENDING', error: 'waiting' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }));
    await expect(
      new ReconnectingSSEClient({
        url: 'http://x/api',
        method: 'POST',
        body: {},
        signal: new AbortController().signal,
        onEvent: () => {},
        backoff: NO_BACKOFF,
      }).run(),
    ).rejects.toMatchObject({ status: 409, httpBody: { code: 'INTERACTION_PENDING' } });
    expect(n).toBe(1);
  });

  it('retries a transient 503 and honors its Retry-After hint', async () => {
    let n = 0;
    const backoff = { nextDelay: vi.fn(() => 60_000) };
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      if (n === 1) {
        return new Response(JSON.stringify({ code: 'IDEMPOTENCY_RETRY_LATER' }), {
          status: 503,
          headers: {
            'content-type': 'application/json',
            'Retry-After': '0',
          },
        });
      }
      return sseResponse(['event: done\ndata: {}\n\n']);
    }));

    await Promise.race([
      new ReconnectingSSEClient({
        url: 'http://x/api',
        method: 'POST',
        body: { client_msg_id: 'stable' },
        signal: new AbortController().signal,
        onEvent: () => {},
        backoff,
      }).run(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Retry-After=0 was ignored')),
          250,
        );
        timer.unref?.();
      }),
    ]);

    expect(n).toBe(2);
    expect(backoff.nextDelay).toHaveBeenCalledTimes(1);
  });

  it('forwards malformed blocks to a custom onParseError and keeps valid events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'garbage block\n\nevent: text\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n',
    ])));
    const errors: string[] = [];
    const events: string[] = [];
    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'GET',
      signal: new AbortController().signal,
      onEvent: (ev) => events.push(ev.event),
      onParseError: (err) => errors.push(err.raw),
      backoff: NO_BACKOFF,
    }).run();
    expect(events).toEqual(['text', 'done']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('garbage block');
  });

  it('defaults to a console.warn diagnostic when no onParseError is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'garbage block\n\nevent: done\ndata: {}\n\n',
    ])));
    await new ReconnectingSSEClient({
      url: 'http://x/api',
      method: 'GET',
      signal: new AbortController().signal,
      onEvent: () => {},
      backoff: NO_BACKOFF,
    }).run();
    expect(warn).toHaveBeenCalledWith(
      '[sse] dropping malformed event block',
      expect.stringContaining('garbage block'),
    );
  });
});
